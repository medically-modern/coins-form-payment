import { useState, useEffect } from "react";
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

type AppState =
  | { mode: "loading" }
  | { mode: "error"; message: string }
  | { mode: "expired" }
  | { mode: "manual" }
  | { mode: "authenticated"; name: string; jwt: string };

export default function App() {
  const [appState, setAppState] = useState<AppState>({ mode: "loading" });
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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");

    if (!token) {
      setAppState({ mode: "manual" });
      return;
    }

    fetch(`${API_URL}/auth/verify/${token}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data.success) {
          setAppState({ mode: "expired" });
          return;
        }

        const jwt = data.token;

        return fetch(`${API_URL}/api/me`, {
          headers: { Authorization: `Bearer ${jwt}` },
        })
          .then((res) => res.json())
          .then((patientData) => {
            setPatient({
              primaryInsurance: patientData.primaryInsurance || "",
              secondaryInsurance: patientData.secondaryInsurance || "",
              serving: patientData.serving || "",
              referralSource: patientData.referralSource || "",
              qtyInf1: patientData.qtyInf1 || "0",
              qtyInf2: patientData.qtyInf2 || "0",
              deductibleRemaining: patientData.deductibleRemaining || "",
              stediCoinsurance: patientData.stediCoinsurance || "",
              oopMaxRemaining: patientData.oopMaxRemaining || "",
            });
            setAppState({
              mode: "authenticated",
              name: patientData.name || "Patient",
              jwt,
            });
          });
      })
      .catch(() => {
        setAppState({ mode: "error", message: "Unable to connect to the server. Please try again later." });
      });
  }, []);

  const update = (field: keyof Patient, value: string) => {
    setPatient((prev) => ({ ...prev, [field]: value }));
  };

  const isAuthenticated = appState.mode === "authenticated";
  const inputClass = `w-full rounded-md border border-input px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 ${
    isAuthenticated ? "bg-muted text-foreground cursor-not-allowed" : "bg-background"
  }`;

  if (appState.mode === "loading") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto" />
          <p className="text-sm text-muted-foreground">Loading your payment estimate...</p>
        </div>
      </div>
    );
  }

  if (appState.mode === "expired") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="rounded-lg border bg-card p-8 max-w-md text-center space-y-3">
          <h2 className="text-lg font-semibold text-foreground">Link Expired</h2>
          <p className="text-sm text-muted-foreground">
            This payment link has expired or is no longer valid. Please contact Medically Modern to request a new link.
          </p>
        </div>
      </div>
    );
  }

  if (appState.mode === "error") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="rounded-lg border bg-card p-8 max-w-md text-center space-y-3">
          <h2 className="text-lg font-semibold text-foreground">Something went wrong</h2>
          <p className="text-sm text-muted-foreground">{appState.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card px-6 py-4">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Co-Insurance / OOP Payment Estimator
        </h1>
        {isAuthenticated ? (
          <p className="text-sm text-muted-foreground mt-0.5">
            Estimate for <span className="font-medium text-foreground">{appState.name}</span>
          </p>
        ) : (
          <p className="text-sm text-muted-foreground mt-0.5">
            Estimate patient out-of-pocket costs per fill
          </p>
        )}
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        <div className="rounded-lg border bg-card p-5 space-y-5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            {isAuthenticated ? "Your Insurance Details" : "Patient Insurance Details"}
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Primary Insurance</label>
              {isAuthenticated ? (
                <div className={inputClass}>{patient.primaryInsurance || "—"}</div>
              ) : (
                <select
                  className={inputClass}
                  value={patient.primaryInsurance}
                  onChange={(e) => update("primaryInsurance", e.target.value)}
                >
                  <option value="">Select insurance...</option>
                  {INSURANCE_OPTIONS.map((ins) => (
                    <option key={ins} value={ins}>{ins}</option>
                  ))}
                </select>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Secondary Insurance</label>
              {isAuthenticated ? (
                <div className={inputClass}>{patient.secondaryInsurance || "None"}</div>
              ) : (
                <input
                  type="text"
                  className={inputClass}
                  placeholder="e.g. NY Medicaid, Medicare Supplement"
                  value={patient.secondaryInsurance}
                  onChange={(e) => update("secondaryInsurance", e.target.value)}
                />
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Serving</label>
              {isAuthenticated ? (
                <div className={inputClass}>{patient.serving || "—"}</div>
              ) : (
                <select
                  className={inputClass}
                  value={patient.serving}
                  onChange={(e) => update("serving", e.target.value)}
                >
                  <option value="">Select serving...</option>
                  {SERVING_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              )}
            </div>
          </div>

          <div className="border-t pt-4">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-3">
              Benefits (from Stedi)
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Deductible Remaining</label>
                {isAuthenticated ? (
                  <div className={inputClass}>{patient.deductibleRemaining || "—"}</div>
                ) : (
                  <input
                    type="text"
                    className={inputClass}
                    placeholder="e.g. 1500"
                    value={patient.deductibleRemaining}
                    onChange={(e) => update("deductibleRemaining", e.target.value)}
                  />
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Coinsurance %</label>
                {isAuthenticated ? (
                  <div className={inputClass}>{patient.stediCoinsurance || "—"}</div>
                ) : (
                  <input
                    type="text"
                    className={inputClass}
                    placeholder="e.g. 20"
                    value={patient.stediCoinsurance}
                    onChange={(e) => update("stediCoinsurance", e.target.value)}
                  />
                )}
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">OOP Max Remaining</label>
                {isAuthenticated ? (
                  <div className={inputClass}>{patient.oopMaxRemaining || "—"}</div>
                ) : (
                  <input
                    type="text"
                    className={inputClass}
                    placeholder="e.g. 5000"
                    value={patient.oopMaxRemaining}
                    onChange={(e) => update("oopMaxRemaining", e.target.value)}
                  />
                )}
              </div>
            </div>
          </div>
        </div>

        <OopEstimateCard patient={patient} />

        {isAuthenticated && (
          <div className="rounded-lg border bg-card p-5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-3">
              Payment
            </p>
            <p className="text-sm text-muted-foreground">
              Payment processing will be available soon. Please contact Medically Modern for payment arrangements.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
