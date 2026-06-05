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

/** Format a date string (YYYY-MM-DD) to MM/DD/YYYY — avoids timezone shift */
function fmtDate(d: string): string {
  const parts = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!parts) return d;
  return `${parts[2]}/${parts[3]}/${parts[1]}`;
}

/** Strip suffixes like "Commercial", "Medicare", "Medicaid", etc. to get user-friendly insurance name */
function friendlyInsurer(raw: string): string {
  if (!raw) return "Insurance";
  return raw
    .replace(/\s*(Commercial|Medicare|Medicaid|Low-Cost|\(JLJ\))\s*/gi, " ")
    .replace(/\s*A&B\s*/g, " ")
    .trim() || raw;
}

/** Medically Modern logo */
function Logo() {
  return (
    <img
      src="https://medicallymodern.com/wp-content/uploads/2025/07/imgi_1_default.png"
      alt="Medically Modern"
      style={{ height: 30, width: "auto" }}
    />
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
        <header className="flex items-center justify-center py-5">
          <Logo />
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
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 18px 64px" }}>
      <div style={{ width: "100%", maxWidth: 430 }}>
        {/* Brand */}
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 22 }}>
          <Logo />
        </div>

        {/* Card */}
        <div style={{ background: "#fff", borderRadius: 22, boxShadow: "0 1px 2px rgba(27,42,40,.04), 0 12px 32px rgba(27,42,40,.06)", overflow: "hidden" }}>
          {/* Hero */}
          <div style={{ padding: "30px 28px 26px", textAlign: "center", borderBottom: "1px solid #ECEAE4" }}>
            <div style={{ fontSize: 14, color: "#5A6B68", marginBottom: 14 }}>
              Hi <b style={{ color: "#1B2A28", fontWeight: 600 }}>{data.name.split(" ")[0]}</b> — here's your statement
            </div>

            {/* Reorder card */}
            <div style={{ display: "flex", justifyContent: "center", background: "#F7F6F2", border: "1px solid #ECEAE4", borderRadius: 14, padding: "11px 13px", marginBottom: 22, fontSize: 12.5, lineHeight: 1.45, color: "#5A6B68" }}>
              <span>
                Date of service: <b style={{ color: "#1B2A28", fontWeight: 600 }}>{data.dos ? fmtDate(data.dos) : "N/A"}</b>
              </span>
            </div>

            <div style={{ fontSize: 11, letterSpacing: ".13em", textTransform: "uppercase" as const, color: "#808E8B", fontWeight: 600, marginBottom: 6 }}>Your total</div>
            <div style={{ fontFamily: "'Fraunces',serif", fontWeight: 500, fontSize: 54, lineHeight: 1, letterSpacing: "-.01em", marginBottom: 14 }}>
              {dollars}<span style={{ fontSize: 30, verticalAlign: "top" }}>{cents}</span>
            </div>

            {/* Covered pill */}
            {totalInsurancePaid > 0 && (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "#E4EFEC", color: "#3C6F68", fontSize: 11.5, fontWeight: 600, padding: "7px 13px", borderRadius: 100, whiteSpace: "nowrap" as const }}>
                <svg style={{ width: 13, height: 13, flexShrink: 0 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                {friendlyInsurer(data.primaryPayor)} covered {fmt(totalInsurancePaid)}
              </div>
            )}
          </div>

          {/* Overall coverage bar */}
          <div style={{ padding: "22px 28px 8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 15, marginBottom: 9 }}>
              <span style={{ color: "#5A6B68" }}>Total cost</span>
              <span style={{ fontWeight: 600 }}>{fmt(totalFullPrice)}</span>
            </div>
            <div style={{ height: 9, borderRadius: 100, background: "#EAEDEB", overflow: "hidden", display: "flex" }}>
              <div style={{ height: "100%", background: "linear-gradient(90deg,#4E8A82,#3C6F68)", borderRadius: 100, width: `${insurancePctTotal}%` }} />
            </div>
            <div style={{ display: "flex", gap: 18, justifyContent: "center", marginTop: 14, fontSize: 14, color: "#5A6B68" }}>
              <span><i style={{ width: 9, height: 9, borderRadius: 3, display: "inline-block", marginRight: 6, verticalAlign: "middle", background: "#4E8A82" }} />Insurance paid {fmt(totalInsurancePaid)}</span>
              <span><i style={{ width: 9, height: 9, borderRadius: 3, display: "inline-block", marginRight: 6, verticalAlign: "middle", background: "#A0ADAA" }} />You pay {fmt(data.totalPatientOwes)}</span>
            </div>
          </div>

          {/* Itemized */}
          <div style={{ padding: "8px 28px 4px" }}>
            <div style={{ fontSize: 11, letterSpacing: ".13em", textTransform: "uppercase" as const, color: "#808E8B", fontWeight: 600, margin: "18px 0 6px" }}>Breakdown by item</div>

            {data.lineItems.map((li, i) => {
              const insurancePaid = li.secondaryPaidLine;
              const fullPrice = insurancePaid + li.patientOwes;
              const insurancePct = fullPrice > 0 ? (insurancePaid / fullPrice) * 100 : 0;
              const isFullyCovered = li.patientOwes === 0;

              return (
                <div key={i} style={{ padding: "16px 0", borderBottom: i < data.lineItems.length - 1 ? "1px solid #ECEAE4" : "none" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 600 }}>{li.name}</div>
                      <div style={{ fontSize: 10.5, color: "#A0ADAA", marginTop: 2, letterSpacing: ".02em", fontWeight: 400 }}>{li.hcpcCode}</div>
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 600, whiteSpace: "nowrap" as const, color: isFullyCovered ? "#4E8A82" : undefined }}>{fmt(li.patientOwes)}</div>
                  </div>
                  <div style={{ height: 6, borderRadius: 100, background: "#EAEDEB", margin: "11px 0 7px", overflow: "hidden" }}>
                    <div style={{ height: "100%", background: "linear-gradient(90deg,#4E8A82,#3C6F68)", borderRadius: 100, width: `${insurancePct}%` }} />
                  </div>
                  <div style={{ fontSize: 13.5, color: "#5A6B68" }}>
                    {isFullyCovered ? (
                      <>Fully covered — insurance paid <b style={{ color: "#4E8A82", fontWeight: 600 }}>{fmt(insurancePaid)}</b></>
                    ) : (
                      <>Insurance paid <b style={{ color: "#4E8A82", fontWeight: 600 }}>{fmt(insurancePaid)}</b> of {fmt(fullPrice)}</>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Total strip */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 28px", background: "#FAFBFA", borderTop: "1px solid #ECEAE4" }}>
            <span style={{ fontSize: 14, color: "#5A6B68" }}>Your share of cost</span>
            <span style={{ fontFamily: "'Fraunces',serif", fontSize: 26, fontWeight: 500 }}>{fmt(data.totalPatientOwes)}</span>
          </div>

          {/* Pay area — inside card */}
          <div style={{ padding: "20px 28px 26px" }}>
            {data.totalPatientOwes > 0 && (
              <button
                onClick={handlePay}
                style={{ width: "100%", border: "none", cursor: "pointer", background: "linear-gradient(150deg,#4E8A82,#3C6F68)", color: "#fff", fontFamily: "'Hanken Grotesk',sans-serif", fontSize: 16, fontWeight: 600, letterSpacing: ".2px", padding: 16, borderRadius: 15, boxShadow: "0 8px 20px rgba(62,111,104,.28)" }}
              >
                Pay {fmt(data.totalPatientOwes)}
              </button>
            )}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, marginTop: 14, fontSize: 12, color: "#5A6B68" }}>
              <svg style={{ width: 13, height: 13 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>
              Secure payment by Stripe &middot; HSA/FSA accepted
            </div>
            <div style={{ textAlign: "center" as const, fontSize: 11, color: "#808E8B", marginTop: 13, lineHeight: 1.5, maxWidth: 340, marginLeft: "auto", marginRight: "auto" }}>
              A receipt that meets HSA/FSA reimbursement standards will be downloadable after payment.
            </div>

            {/* Questions — inside card */}
            <div style={{ marginTop: 20, paddingTop: 18, borderTop: "1px solid #ECEAE4" }}>
              <span style={{ display: "block", fontSize: 12, color: "#5A6B68", fontWeight: 600, marginBottom: 8, textAlign: "center" as const }}>Questions about this statement?</span>
              {questionStatus === "sent" ? (
                <div style={{ textAlign: "center" as const, fontSize: 13, color: "#4E8A82", fontWeight: 600, padding: "8px 0" }}>
                  Message sent — we'll get back to you shortly.
                </div>
              ) : (
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    type="text"
                    value={questionText}
                    onChange={(e) => { setQuestionText(e.target.value); if (questionStatus === "error") setQuestionStatus("idle"); }}
                    onKeyDown={(e) => { if (e.key === "Enter") handleSendQuestion(); }}
                    placeholder="Send us a message…"
                    disabled={questionStatus === "sending"}
                    style={{ flex: 1, border: "1px solid #ECEAE4", background: "#FAFBFA", borderRadius: 11, padding: "10px 13px", fontFamily: "'Hanken Grotesk',sans-serif", fontSize: 13, color: "#1B2A28", outline: "none" }}
                  />
                  <button
                    onClick={handleSendQuestion}
                    disabled={!questionText.trim() || questionStatus === "sending"}
                    style={{ flexShrink: 0, width: 40, height: 40, border: "none", cursor: "pointer", borderRadius: 11, background: "#E4EFEC", color: "#3C6F68", display: "grid", placeItems: "center", opacity: (!questionText.trim() || questionStatus === "sending") ? 0.4 : 1 }}
                  >
                    <svg style={{ width: 16, height: 16 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 2 11 13"/><path d="m22 2-7 20-4-9-9-4 20-7z"/></svg>
                  </button>
                </div>
              )}
              {questionStatus === "error" && (
                <div style={{ fontSize: 11, color: "#e53e3e", textAlign: "center" as const, marginTop: 8 }}>Failed to send. Please try again.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
