import { useState } from "react";
import { OopEstimateCard } from "@/components/OopEstimateCard";
import { PAYER_RATE_SCHEDULE } from "@/lib/oopEstimator";
import type { Patient } from "@/lib/types";

const INSURANCE_OPTIONS = Object.keys(PAYER_RATE_SCHEDULE).sort();

const SERVING_OPTIONS = [
  "CGM",
  "Insulin Pump",
  "Supplies Only",
  "Insulin Pump + CGM",
  "Supplies + CGM",
];

export default function App() {
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

  const update = (field: keyof Patient, value: string) => {
    setPatient((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card px-6 py-4">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          Co-Insurance / OOP Payment Estimator
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Estimate patient out-of-pocket costs per fill
        </p>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
        {/* Input Form */}
        <div className="rounded-lg border bg-card p-5 space-y-5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            Patient Insurance Details
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Primary Insurance */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Primary Insurance</label>
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
            </div>

            {/* Secondary Insurance */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Secondary Insurance</label>
              <input
                type="text"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                placeholder="e.g. NY Medicaid, Medicare Supplement"
                value={patient.secondaryInsurance}
                onChange={(e) => update("secondaryInsurance", e.target.value)}
              />
            </div>

            {/* Serving */}
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Serving</label>
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
            </div>

            {/* Infusion Set Qty 1 */}
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

            {/* Infusion Set Qty 2 */}
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

            {/* Referral Source */}
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
          </div>

          {/* Benefits Section */}
          <div className="border-t pt-4">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-3">
              Benefits (from Stedi Eligibility)
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Deductible Remaining</label>
                <input
                  type="text"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  placeholder="e.g. 1500"
                  value={patient.deductibleRemaining}
                  onChange={(e) => update("deductibleRemaining", e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">Coinsurance %</label>
                <input
                  type="text"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  placeholder="e.g. 20"
                  value={patient.stediCoinsurance}
                  onChange={(e) => update("stediCoinsurance", e.target.value)}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium text-foreground">OOP Max Remaining</label>
                <input
                  type="text"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                  placeholder="e.g. 5000"
                  value={patient.oopMaxRemaining}
                  onChange={(e) => update("oopMaxRemaining", e.target.value)}
                />
              </div>
            </div>
          </div>
        </div>

        {/* OOP Estimate Card — exact same component from command-center */}
        <OopEstimateCard patient={patient} />
      </main>
    </div>
  );
}
