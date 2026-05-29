import { useState, useEffect } from "react";

const API_URL = import.meta.env.VITE_API_URL || "https://coins-form-payment-production.up.railway.app";

/** Format a number as USD with commas (e.g. 1234.56 → "$1,234.56") */
function fmt(n: number): string {
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

interface LineItem {
  name: string;
  hcpcCode: string;
  modifiers: string;
  coinsuranceAmount: number;
  deductibleAmount: number;
  patientOwes: number;
  secondaryPaidLine: number;
  quantity: string;
}

interface PatientData {
  name: string;
  dob: string;
  dos: string;
  primaryPayor: string;
  secondaryPayer: string;
  lineItems: LineItem[];
  totalPatientOwes: number;
  isPaid: boolean;
  paidAmount: number;
  paidDate: string;
  stripeChargeId: string;
  secondaryStatus: string;
}

type AppState =
  | { mode: "loading" }
  | { mode: "error"; message: string }
  | { mode: "expired" }
  | { mode: "no-token" }
  | { mode: "authenticated"; jwt: string; data: PatientData }
  | { mode: "paying" }
  | { mode: "success" };

export default function App() {
  const [appState, setAppState] = useState<AppState>({ mode: "loading" });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");
    const status = params.get("status");

    if (!token) {
      setAppState({ mode: "no-token" });
      return;
    }

    // If returning from Stripe success
    if (status === "success") {
      setAppState({ mode: "success" });
      // Still verify + load data for the receipt
      verifyAndLoad(token, true);
      return;
    }

    verifyAndLoad(token, false);
  }, []);

  async function verifyAndLoad(token: string, isReturn: boolean) {
    try {
      const verifyRes = await fetch(`${API_URL}/auth/verify/${token}`);
      const verifyData = await verifyRes.json();

      if (!verifyData.success) {
        setAppState({ mode: "expired" });
        return;
      }

      const jwt = verifyData.token;

      const meRes = await fetch(`${API_URL}/api/me`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const patientData: PatientData = await meRes.json();

      if (isReturn || patientData.isPaid) {
        setAppState({ mode: "success" });
      }

      // Always update to authenticated so we have data for receipt
      setAppState({
        mode: patientData.isPaid ? "success" : (isReturn ? "success" : "authenticated"),
        jwt,
        data: patientData,
      } as any);
    } catch {
      setAppState({ mode: "error", message: "Unable to connect. Please try again later." });
    }
  }

  // ─── No token ───
  if (appState.mode === "no-token") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="rounded-lg border bg-card p-8 max-w-md text-center space-y-3">
          <div className="text-3xl">&#128274;</div>
          <h2 className="text-lg font-semibold text-foreground">Invalid Link</h2>
          <p className="text-sm text-muted-foreground">
            This page requires a valid payment link. Please use the link sent to your phone.
          </p>
        </div>
      </div>
    );
  }

  // ─── Loading ───
  if (appState.mode === "loading") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
          <p className="text-sm text-muted-foreground">Loading your payment details...</p>
        </div>
      </div>
    );
  }

  // ─── Expired ───
  if (appState.mode === "expired") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="rounded-lg border bg-card p-8 max-w-md text-center space-y-3">
          <div className="text-3xl">&#128274;</div>
          <h2 className="text-lg font-semibold text-foreground">Link Expired</h2>
          <p className="text-sm text-muted-foreground">
            This payment link has expired or is no longer valid. Please contact Mid-Island Medical to request a new one.
          </p>
        </div>
      </div>
    );
  }

  // ─── Error ───
  if (appState.mode === "error") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="rounded-lg border bg-card p-8 max-w-md text-center space-y-3">
          <div className="text-3xl">&#9888;&#65039;</div>
          <h2 className="text-lg font-semibold text-foreground">Something went wrong</h2>
          <p className="text-sm text-muted-foreground">{appState.message}</p>
        </div>
      </div>
    );
  }

  // ─── Paying (redirect in progress) ───
  if (appState.mode === "paying") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
          <p className="text-sm text-muted-foreground">Redirecting to secure payment...</p>
        </div>
      </div>
    );
  }

  // ─── Success / Receipt ───
  if (appState.mode === "success") {
    const data = (appState as any).data as PatientData | undefined;
    const jwt = (appState as any).jwt as string | undefined;

    return (
      <div className="min-h-screen bg-background">
        <header className="border-b bg-card px-6 py-4">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Mid-Island Medical Supply
          </h1>
        </header>
        <main className="max-w-lg mx-auto px-4 py-8">
          <div className="rounded-lg border bg-card p-6 text-center space-y-4">
            <div className="text-4xl">&#9989;</div>
            <h2 className="text-xl font-semibold text-foreground">Payment Received</h2>
            <p className="text-sm text-muted-foreground">
              Thank you{data ? `, ${data.name}` : ""}! Your payment
              {data ? ` of ${fmt(data.paidAmount)}` : ""} has been received.
            </p>
            {data?.stripeChargeId && (
              <p className="text-xs text-muted-foreground">
                Confirmation: {data.stripeChargeId}
              </p>
            )}

            {/* Receipt download */}
            {jwt && (
              <a
                href={`${API_URL}/api/receipt`}
                onClick={(e) => {
                  e.preventDefault();
                  // Fetch with auth and trigger download
                  fetch(`${API_URL}/api/receipt`, {
                    headers: { Authorization: `Bearer ${jwt}` },
                  })
                    .then((r) => r.blob())
                    .then((blob) => {
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `receipt-${data?.name?.replace(/\s+/g, "-") || "payment"}.pdf`;
                      a.click();
                      URL.revokeObjectURL(url);
                    });
                }}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 cursor-pointer"
              >
                &#128196; Download Receipt (FSA/HSA)
              </a>
            )}

            <p className="text-xs text-muted-foreground mt-4">
              Stripe will also email a receipt to the card on file.
            </p>
          </div>
        </main>
      </div>
    );
  }

  // ─── Authenticated: show ERA breakdown + Pay button ───
  const { jwt, data } = appState as { mode: "authenticated"; jwt: string; data: PatientData };

  async function handlePay() {
    setAppState({ mode: "paying" } as any);
    try {
      const res = await fetch(`${API_URL}/api/create-checkout-session`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
      });
      const result = await res.json();
      if (result.checkoutUrl) {
        window.location.href = result.checkoutUrl;
      } else {
        setAppState({ mode: "error", message: result.error || "Unable to start payment." });
      }
    } catch {
      setAppState({ mode: "error", message: "Unable to connect to payment server." });
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card px-6 py-4">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Mid-Island Medical Supply
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Payment for <span className="font-medium text-foreground">{data.name}</span>
        </p>
      </header>

      <main className="max-w-lg mx-auto px-4 py-6 space-y-5">
        {/* Claim Info */}
        <div className="rounded-lg border bg-card p-5 space-y-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            Claim Details
          </p>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-muted-foreground">Date of Service</span>
              <p className="font-medium text-foreground">{data.dos || "N/A"}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Primary Payor</span>
              <p className="font-medium text-foreground">{data.primaryPayor || "N/A"}</p>
            </div>
            {data.secondaryPayer && (
              <div>
                <span className="text-muted-foreground">Secondary Payor</span>
                <p className="font-medium text-foreground">{data.secondaryPayer}</p>
              </div>
            )}
          </div>
        </div>

        {/* ERA Line Items */}
        <div className="rounded-lg border bg-card p-5 space-y-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            Your Share of Cost
          </p>

          <div className="space-y-2">
            {data.lineItems.map((li, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-border last:border-0">
                <div>
                  <p className="text-sm font-medium text-foreground">{li.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {li.hcpcCode}{li.modifiers ? ` ${li.modifiers}` : ""}
                  </p>
                </div>
                <p className={`text-sm font-semibold ${li.patientOwes > 0 ? "text-foreground" : "text-muted-foreground"}`}>
                  {fmt(li.patientOwes)}
                </p>
              </div>
            ))}
          </div>

          {/* Total */}
          <div className="flex items-center justify-between pt-3 border-t-2 border-foreground/20">
            <p className="text-base font-bold text-foreground">Total Due</p>
            <p className="text-xl font-bold text-foreground">{fmt(data.totalPatientOwes)}</p>
          </div>
        </div>

        {/* Pay Button */}
        {data.totalPatientOwes > 0 && (
          <button
            onClick={handlePay}
            className="w-full rounded-md bg-primary py-3 text-base font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            Pay {fmt(data.totalPatientOwes)}
          </button>
        )}

        <p className="text-xs text-center text-muted-foreground">
          Secure payment powered by Stripe. HSA/FSA cards accepted.
        </p>
        <p className="text-xs text-center text-muted-foreground">
          You will receive a copy of your receipt after payment that meets HSA/FSA reimbursement standards.
        </p>
      </main>
    </div>
  );
}
