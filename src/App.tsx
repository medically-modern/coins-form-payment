import { useState, useEffect } from "react";

const API_URL = import.meta.env.VITE_API_URL || "https://coins-form-payment-production.up.railway.app";

/** Format a number as USD with commas (e.g. 1234.56 → "$1,234.56") */
function fmt(n: number): string {
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Split a formatted dollar amount into dollars and cents for superscript display */
function fmtSplit(n: number): { dollars: string; cents: string } {
  const parts = n.toFixed(2).split(".");
  return {
    dollars: "$" + parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ","),
    cents: "." + parts[1],
  };
}

/** Medically Modern logo/icon */
function Logo() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="16" cy="16" r="16" fill="hsl(168 30% 38%)" />
      <path
        d="M16 8C12.5 8 10 10.5 10 13.5C10 18 16 24 16 24C16 24 22 18 22 13.5C22 10.5 19.5 8 16 8Z"
        fill="white"
        stroke="white"
        strokeWidth="0.5"
      />
      <path
        d="M14 14.5H18M16 12.5V16.5"
        stroke="hsl(168 30% 38%)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
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
  const [questionText, setQuestionText] = useState("");
  const [questionStatus, setQuestionStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");

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

  // ─── Shell for status screens ───
  const StatusShell = ({ children }: { children: React.ReactNode }) => (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-center gap-2 py-5">
        <Logo />
        <span className="text-lg font-semibold tracking-tight text-foreground">Medically Modern</span>
      </header>
      <main className="max-w-md mx-auto px-4 pb-10">
        <div className="rounded-2xl bg-card shadow-sm p-8 text-center space-y-3">
          {children}
        </div>
      </main>
    </div>
  );

  // ─── No token ───
  if (appState.mode === "no-token") {
    return (
      <StatusShell>
        <div className="text-3xl">&#128274;</div>
        <h2 className="text-lg font-semibold text-foreground">Invalid Link</h2>
        <p className="text-sm text-muted-foreground">
          This page requires a valid payment link. Please use the link sent to your phone.
        </p>
      </StatusShell>
    );
  }

  // ─── Loading ───
  if (appState.mode === "loading") {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <Logo />
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
        <p className="text-sm text-muted-foreground">Loading your statement...</p>
      </div>
    );
  }

  // ─── Expired ───
  if (appState.mode === "expired") {
    return (
      <StatusShell>
        <div className="text-3xl">&#128274;</div>
        <h2 className="text-lg font-semibold text-foreground">Link Expired</h2>
        <p className="text-sm text-muted-foreground">
          This payment link has expired or is no longer valid. Please contact us to request a new one.
        </p>
      </StatusShell>
    );
  }

  // ─── Error ───
  if (appState.mode === "error") {
    return (
      <StatusShell>
        <div className="text-3xl">&#9888;&#65039;</div>
        <h2 className="text-lg font-semibold text-foreground">Something went wrong</h2>
        <p className="text-sm text-muted-foreground">{appState.message}</p>
      </StatusShell>
    );
  }

  // ─── Paying (redirect in progress) ───
  if (appState.mode === "paying") {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <Logo />
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
        <p className="text-sm text-muted-foreground">Redirecting to secure payment...</p>
      </div>
    );
  }

  // ─── Success / Receipt ───
  if (appState.mode === "success") {
    const data = (appState as any).data as PatientData | undefined;
    const jwt = (appState as any).jwt as string | undefined;

    return (
      <div className="min-h-screen bg-background">
        <header className="flex items-center justify-center gap-2 py-5">
          <Logo />
          <span className="text-lg font-semibold tracking-tight text-foreground">Medically Modern</span>
        </header>
        <main className="max-w-md mx-auto px-4 pb-10">
          <div className="rounded-2xl bg-card shadow-sm p-8 text-center space-y-5">
            <div className="mx-auto w-12 h-12 rounded-full bg-emerald-50 flex items-center justify-center">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="hsl(168 30% 38%)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
            </div>
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

            {jwt && (
              <a
                href={`${API_URL}/api/receipt`}
                onClick={(e) => {
                  e.preventDefault();
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
                className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 cursor-pointer transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Download Receipt (FSA/HSA)
              </a>
            )}

            <p className="text-xs text-muted-foreground">
              A receipt will also be emailed to the card on file.
            </p>
          </div>
        </main>
      </div>
    );
  }

  // ─── Authenticated: show statement + Pay button ───
  const { jwt, data } = appState as { mode: "authenticated"; jwt: string; data: PatientData };

  const totalInsurancePaid = data.lineItems.reduce((s, li) => s + li.secondaryPaidLine, 0);
  const totalFullPrice = totalInsurancePaid + data.totalPatientOwes;
  const insurancePctTotal = totalFullPrice > 0 ? (totalInsurancePaid / totalFullPrice) * 100 : 0;
  const itemNames = data.lineItems.map((li) => li.name).join(", ");
  const { dollars, cents } = fmtSplit(data.totalPatientOwes);

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

  async function handleSendQuestion() {
    if (!questionText.trim()) return;
    setQuestionStatus("sending");
    try {
      const res = await fetch(`${API_URL}/api/send-message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${jwt}`,
        },
        body: JSON.stringify({ message: questionText.trim() }),
      });
      if (res.ok) {
        setQuestionStatus("sent");
        setQuestionText("");
      } else {
        setQuestionStatus("error");
      }
    } catch {
      setQuestionStatus("error");
    }
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="flex items-center justify-center gap-2 py-5">
        <Logo />
        <span className="text-lg font-semibold tracking-tight text-foreground">Medically Modern</span>
      </header>

      <main className="max-w-md mx-auto px-4 pb-10">
        <div className="rounded-2xl bg-card shadow-sm overflow-hidden">
          {/* Greeting + claim context */}
          <div className="px-6 pt-6 pb-5 text-center space-y-3">
            <p className="text-base text-muted-foreground">
              Hi <span className="font-semibold text-foreground">{data.name.split(" ")[0]}</span> — here's your statement
            </p>

            {/* Date of service card */}
            <div className="rounded-xl bg-foreground text-primary-foreground px-4 py-3 text-sm text-left flex items-start gap-2.5">
              <svg className="w-4 h-4 mt-0.5 shrink-0 opacity-70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"/></svg>
              <span className="opacity-90">
                Date of service for your{" "}
                <span className="font-semibold text-white">{itemNames}</span>
                {" "}re-order: <span className="font-semibold text-white">{data.dos || "N/A"}</span>
              </span>
            </div>
          </div>

          {/* Total amount */}
          <div className="text-center pb-5 space-y-2">
            <p className="text-[11px] uppercase tracking-[0.15em] text-muted-foreground font-semibold">Your Total</p>
            <p className="font-serif text-foreground leading-none" style={{ fontSize: "3.5rem", fontWeight: 700 }}>
              {dollars}<sup className="text-2xl align-super">{cents}</sup>
            </p>

            {/* Insurance badge */}
            {totalInsurancePaid > 0 && (
              <div className="inline-flex items-center gap-1.5 bg-primary/10 text-primary rounded-full px-4 py-1.5 text-sm font-medium mt-1">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                {data.primaryPayor || "Insurance"} covered {fmt(totalInsurancePaid)} of your care
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="border-t border-border" />

          {/* Total cost summary bar */}
          <div className="px-6 py-5 space-y-2.5">
            <div className="flex justify-between text-sm">
              <span className="text-muted-foreground">Total cost of supplies</span>
              <span className="font-semibold text-foreground tabular-nums">{fmt(totalFullPrice)}</span>
            </div>
            <div className="h-3 w-full flex rounded-full overflow-hidden bg-muted/50">
              <div className="bg-primary h-full rounded-full" style={{ width: `${insurancePctTotal}%` }} />
            </div>
            <div className="flex items-center justify-center gap-5 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-2.5 h-2.5 rounded-sm bg-primary" />
                Insurance paid {fmt(totalInsurancePaid)}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-2.5 h-2.5 rounded-sm bg-muted" />
                You pay {fmt(data.totalPatientOwes)}
              </span>
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-border" />

          {/* Breakdown by item */}
          <div className="px-6 py-5 space-y-5">
            <p className="text-[11px] uppercase tracking-[0.15em] text-muted-foreground font-semibold">
              Breakdown by Item
            </p>

            <div className="divide-y divide-border">
              {data.lineItems.map((li, i) => {
                const insurancePaid = li.secondaryPaidLine;
                const fullPrice = insurancePaid + li.patientOwes;
                const insurancePct = fullPrice > 0 ? (insurancePaid / fullPrice) * 100 : 0;
                const isFullyCovered = li.patientOwes === 0;

                return (
                  <div key={i} className={`space-y-1.5 ${i > 0 ? "pt-4" : ""} ${i < data.lineItems.length - 1 ? "pb-4" : ""}`}>
                    <div className="flex items-baseline justify-between">
                      <div>
                        <p className="text-sm font-semibold text-foreground">{li.name}</p>
                        <p className="text-xs text-muted-foreground">{li.hcpcCode}{li.modifiers ? ` ${li.modifiers}` : ""}</p>
                      </div>
                      <p className={`text-sm font-semibold tabular-nums ${isFullyCovered ? "text-primary" : "text-foreground"}`}>
                        {fmt(li.patientOwes)}
                      </p>
                    </div>

                    <div className="h-2.5 w-full flex rounded-full overflow-hidden bg-muted/50">
                      {insurancePct > 0 && (
                        <div className="bg-primary h-full rounded-full" style={{ width: `${insurancePct}%` }} />
                      )}
                    </div>

                    <p className="text-xs text-muted-foreground">
                      {isFullyCovered ? (
                        <>Fully covered — insurance paid <span className="font-medium text-foreground">{fmt(insurancePaid)}</span></>
                      ) : (
                        <>Insurance paid <span className="font-medium text-foreground">{fmt(insurancePaid)}</span> of {fmt(fullPrice)}</>
                      )}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-border" />

          {/* Your share footer */}
          <div className="px-6 py-4 flex items-center justify-between">
            <span className="text-sm text-muted-foreground">Your share of cost</span>
            <span className="text-2xl font-bold text-foreground tabular-nums">{fmt(data.totalPatientOwes)}</span>
          </div>
        </div>

        {/* Pay Button */}
        {data.totalPatientOwes > 0 && (
          <button
            onClick={handlePay}
            className="w-full mt-5 rounded-full bg-primary py-3.5 text-base font-semibold text-primary-foreground hover:bg-primary/90 transition-colors shadow-sm"
          >
            Pay {fmt(data.totalPatientOwes)}
          </button>
        )}

        {/* Footer text */}
        <div className="text-center mt-4 space-y-1">
          <p className="text-[11px] text-muted-foreground flex items-center justify-center gap-1">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
            Secure payment by Stripe &middot; HSA/FSA accepted
          </p>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            A receipt that meets HSA/FSA reimbursement standards will be<br />emailed to you after payment.
          </p>
        </div>

        {/* Questions section */}
        <div className="mt-6 border-t border-border pt-5">
          <p className="text-sm text-center text-muted-foreground mb-3">Questions about this statement?</p>
          {questionStatus === "sent" ? (
            <div className="text-center text-sm text-primary font-medium py-2">
              Message sent — we'll get back to you shortly.
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={questionText}
                onChange={(e) => { setQuestionText(e.target.value); if (questionStatus === "error") setQuestionStatus("idle"); }}
                onKeyDown={(e) => { if (e.key === "Enter") handleSendQuestion(); }}
                placeholder="Send us a message..."
                className="flex-1 rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
                disabled={questionStatus === "sending"}
              />
              <button
                onClick={handleSendQuestion}
                disabled={!questionText.trim() || questionStatus === "sending"}
                className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center hover:bg-primary/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
              </button>
            </div>
          )}
          {questionStatus === "error" && (
            <p className="text-xs text-red-500 text-center mt-2">Failed to send. Please try again.</p>
          )}
        </div>
      </main>
    </div>
  );
}
