import { useEffect, useState } from "react";
import { OopEstimateCard } from "@/components/OopEstimateCard";
import { PAYER_RATE_SCHEDULE } from "@/lib/oopEstimator";
import type { Patient } from "@/lib/types";

const API_URL = import.meta.env.VITE_API_URL || "https://coins-form-payment-production.up.railway.app";

const INSURANCE_OPTIONS = Object.keys(PAYER_RATE_SCHEDULE).sort();

const SERVING_OPTIONS = [
  "CGM",
  "Insulin Pump",
  "Supplies Only",
  "Insulin Pump + CGM",
  "Supplies + CGM",
];

type AppState = "loading" | "authenticated" | "manual" | "error" | "expired";

export default function App() {
  const [appState, setAppState] = useState<AppState>("loading");
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [patientName, setPatientName] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");

  const [patient, setPatient] = useState<Patient>({
    primaryInsurance: "",
    secondaryInsurance: "",
    serving: "",
    referralSource: "",
    qtyInf1: "0",
    qtyInf2: "0",
    deductibleRemaining: "",
    stediCoinsurance: "",
    oopMaxRemaining: "",
  });

  // On mount: check for token in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");

    if (!token) {
      // No token — show manual entry form
      setAppState("manual");
      return;
    }

    // Verify token with the API
    verifyToken(token);
  }, []);

  async function verifyToken(token: string) {
    try {
      const res = await fetch(`${API_URL}/auth/verify/${token}`);
      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.error || "Invalid or expired link.");
        setAppState("expired");
        return;
      }

      setAuthToken(data.token);
      // Now fetch patient data
      await fetchPatientData(data.token);
    } catch (err) {
      setErrorMessage("Unable to connect. Please try again later.");
      setAppState("error");
    }
  }

  async function fetchPatientData(jwt: string) {
    try {
      const res = await fetch(`${API_URL}/api/me`, {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      const data = await res.json();

      if (!res.ok) {
        setErrorMessage(data.error || "Unable to load your information.");
        setAppState("error");
        return;
      }

      setPatientName(data.name || "");
      setPatient({
        primaryInsurance: data.primaryInsurance || "",
        secondaryInsurance: data.secondaryInsurance || "",
        serving: data.serving || "",
        referralSource: data.referralSource || "",
        qtyInf1: data.qtyInf1 || "0",
        qtyInf2: data.qtyInf2 || "0",
        deductibleRemaining: data.deductibleRemaining || "",
        stediCoinsurance: data.stediCoinsurance || "",
        oopMaxRemaining: data.oopMaxRemaining || "",
      });
      setAppState("authenticated");
    } catch (err) {
      setErrorMessage("Unable to load your information. Please try again.");
      setAppState("error");
    }
  }

  const update = (field: keyof Patient, value: string) => {
    setPatient((prev) => ({ ...prev, [field]: value }));
  };

  // ─── Expired / Error states ───
  if (appState === "loading") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
          <p className="text-sm text-muted-foreground">Loading your payment information…</p>
        </div>
      </div>
    );
  }

  if (appState === "expired") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="rounded-lg border bg-card p-8 max-w-md text-center space-y-4">
          <div className="text-4xl">🔗</div>
          <h2 className="text-lg font-semibold">Link Expired</h2>
          <p className="text-sm text-muted-foreground">{errorMessage}</p>
          <p className="text-sm text-muted-foreground">
            Please contact Medically Modern for a new payment link.
          </p>
        </div>
      </div>
    );
  }

  if (appState === "error") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="rounded-lg border bg-card p-8 max-w-md text-center space-y-4">
          <div className="text-4xl">⚠️</div>
          <h2 className="text-lg font-semibold">Something Went Wrong</h2>
          <p className="text-sm text-muted-foreground">{errorMessage}</p>
          <button
            className="mt-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
            onClick={() => window.location.reload()}
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  // ─── Authenticated (pre-populated from Monday) or Manual entry ───
  const isAuthenticated = appState === "authenticated";

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card px-6 py-4">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Co-Insurance / OOP Payment Estimator
        </h1>
        {isAuthenticated && patientName ? (
          <p className="text-sm text-muted-foreground mt-0.5">
            Estimate for <span className="font-medium text-foreground">{patientName}</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground mt-0.5">
            Estimate patient out-of-pocket costs per fill
          </p>
        )}
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Input Form — editable in manual mode, read-only summary in authenticated mode */}
        <div className="rounded-lg border bg-card p-5 space-y-5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            {isAuthenticated ? "Your Insurance Details" : "Patient Insurance Details"}
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Primary Insurance */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Primary Insurance</label>
              {isAuthenticated ? (
                <p className="text-sm py-2 px-3 rounded-md bg-muted/50">{patient.primaryInsurance || "—"}</p>
              ) : (
                <select
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  value={patient.primaryInsurance}
                  onChange={(e) => update("primaryInsurance", e.target.value)}
                >
                  <option value="">Select insurance…</option>
                  {INSURANCE_OPTIONS.map((ins) => (
                    <option key={ins} value={ins}>{ins}</option>
                  ))}
                </select>
              )}
            </div>

            {/* Secondary Insurance */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Secondary Insurance</label>
              {isAuthenticated ? (
                <p className="text-sm py-2 px-3 rounded-md bg-muted/50">{patient.secondaryInsurance || "None"}</p>
              ) : (
                <input
                  type="text"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  placeholder="e.g. NY Medicaid, Medicare Supplement"
                  value={patient.secondaryInsurance}
                  onChange={(e) => update("secondaryInsurance", e.target.value)}
                />
              )}
            </div>

            {/* Serving */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Serving</label>
              {isAuthenticated ? (
                <p className="text-sm py-2 px-3 rounded-md bg-muted/50">{patient.serving || "—"}</p>
              ) : (
                <select
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  value={patient.serving}
                  onChange={(e) => update("serving", e.target.value)}
                >
                  <option value="">Select serving…</option>
                  {SERVING_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              )}
            </div>

            {/* Infusion Set Qty 1 */}
            {!isAuthenticated && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Infusion Set Qty 1</label>
                <input
                  type="number"
                  min="0"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  value={patient.qtyInf1}
                  onChange={(e) => update("qtyInf1", e.target.value)}
                />
              </div>
            )}

            {/* Infusion Set Qty 2 */}
            {!isAuthenticated && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Infusion Set Qty 2</label>
                <input
                  type="number"
                  min="0"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  value={patient.qtyInf2}
                  onChange={(e) => update("qtyInf2", e.target.value)}
                />
              </div>
            )}

            {/* Referral Source — only in manual mode */}
            {!isAuthenticated && (
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Referral Source</label>
                <input
                  type="text"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  placeholder="e.g. tandem, carecentrix"
                  value={patient.referralSource}
                  onChange={(e) => update("referralSource", e.target.value)}
                />
              </div>
            )}
          </div>

          {/* Benefits Section */}
          <div className="border-t pt-4">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-3">
              Benefits {isAuthenticated ? "(from Stedi)" : "(from Stedi Eligibility)"}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Deductible Remaining</label>
                {isAuthenticated ? (
                  <p className="text-sm py-2 px-3 rounded-md bg-muted/50">{patient.deductibleRemaining ? `$${patient.deductibleRemaining}` : "—"}</p>
                ) : (
                  <input
                    type="text"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                    placeholder="e.g. 1500"
                    value={patient.deductibleRemaining}
                    onChange={(e) => update("deductibleRemaining", e.target.value)}
                  />
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Coinsurance %</label>
                {isAuthenticated ? (
                  <p className="text-sm py-2 px-3 rounded-md bg-muted/50">{patient.stediCoinsurance ? `${patient.stediCoinsurance}%` : "—"}</p>
                ) : (
                  <input
                    type="text"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                    placeholder="e.g. 20"
                    value={patient.stediCoinsurance}
                    onChange={(e) => update("stediCoinsurance", e.target.value)}
                  />
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">OOP Max Remaining</label>
                {isAuthenticated ? (
                  <p className="text-sm py-2 px-3 rounded-md bg-muted/50">{patient.oopMaxRemaining ? `$${patient.oopMaxRemaining}` : "—"}</p>
                ) : (
                  <input
                    type="text"
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                    placeholder="e.g. 5000"
                    value={patient.oopMaxRemaining}
                    onChange={(e) => update("oopMaxRemaining", e.target.value)}
                  />
                )}
              </div>
            </div>
          </div>
        </div>

        {/* OOP Estimate Card — exact same component from command-center */}
        <OopEstimateCard patient={patient} />

        {/* Payment section placeholder (future Stripe integration) */}
        {isAuthenticated && (
          <div className="rounded-lg border bg-card p-5 space-y-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Payment
            </p>
            <p className="text-sm text-muted-foreground italic">
              Online payment coming soon. Please contact Medically Modern to arrange payment.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
