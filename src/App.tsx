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
        {/* Total Due — hero card */}
        <div className="rounded-2xl border bg-card p-6 text-center space-y-1 shadow-sm">
          <p className="text-xs uppercase tracking-widest text-muted-foreground font-semibold">Amount Due</p>
          <p className="text-4xl font-bold tracking-tight text-foreground">{fmt(data.totalPatientOwes)}</p>
          {(() => {
            const totalDed = data.lineItems.reduce((s, li) => s + li.deductibleAmount, 0);
            const totalCoins = data.lineItems.reduce((s, li) => s + li.coinsuranceAmount, 0);
            const parts: string[] = [];
            if (totalDed > 0) parts.push(`${fmt(totalDed)} deductible`);
            if (totalCoins > 0) parts.push(`${fmt(totalCoins)} coinsurance`);
            return parts.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {parts.join(" + ")}
              </p>
            ) : null;
          })()}
        </div>

        {/* Claim Info */}
        <div className="rounded-2xl border bg-card p-5 space-y-3 shadow-sm">
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
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

        {/* Itemized Breakdown */}
        <div className="rounded-2xl border bg-card p-5 space-y-5 shadow-sm">
          <div className="flex items-center justify-between">
            <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">
              Itemized Breakdown
            </p>
            {/* Legend */}
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />
                Insurance
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
                Your share
              </span>
            </div>
          </div>

          <div className="space-y-4">
            {data.lineItems.map((li, i) => {
              const insurancePaid = li.secondaryPaidLine;
              const fullPrice = insurancePaid + li.patientOwes;
              const insurancePct = fullPrice > 0 ? (insurancePaid / fullPrice) * 100 : 0;
              const patientPct = fullPrice > 0 ? (li.patientOwes / fullPrice) * 100 : 0;

              return (
                <div key={i} className="space-y-1.5">
                  <div className="flex items-baseline justify-between">
                    <p className="text-sm font-medium text-foreground">{li.name}</p>
                    <p className="text-xs text-muted-foreground tabular-nums">{fmt(fullPrice)}</p>
                  </div>

                  {/* Bar — no inner text */}
                  <div className="h-5 w-full flex rounded-full overflow-hidden bg-muted/40">
                    {insurancePct > 0 && (
                      <div className="bg-emerald-500 h-full" style={{ width: `${insurancePct}%` }} />
                    )}
                    {patientPct > 0 && (
                      <div className="bg-amber-500 h-full" style={{ width: `${patientPct}%` }} />
                    )}
                  </div>

                  {/* Amounts below */}
                  <div className="flex justify-between text-[11px] tabular-nums">
                    <span className="text-emerald-600 font-medium">
                      Covered {fmt(insurancePaid)}
                    </span>
                    <span className="text-amber-600 font-semibold">
                      You owe {fmt(li.patientOwes)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Pay Button */}
        {data.totalPatientOwes > 0 && (
          <button
            onClick={handlePay}
            className="w-full rounded-xl bg-primary py-3.5 text-base font-semibold text-primary-foreground hover:bg-primary/90 transition-colors shadow-sm"
          >
            Pay {fmt(data.totalPatientOwes)}
          </button>
        )}

        <p className="text-[11px] text-center text-muted-foreground leading-relaxed">
          Secure payment powered by Stripe. HSA/FSA cards accepted.<br />
          A receipt will be provided after payment.
        </p>
      </main>
    </div>
  );
}
