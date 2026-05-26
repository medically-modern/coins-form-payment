import { useMemo } from "react";
import { Card } from "@/components/ui/card";
import type { Patient } from "@/lib/types";
import { estimateOop } from "@/lib/oopEstimator";
import type { OopEstimate, OopLineItem } from "@/lib/oopEstimator";

interface Props {
  patient: Patient;
  /** Override infusion sets count; defaults to 3 if not provided */
  infusionSets?: number;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

/** Per-line display row with distributed deductible + coinsurance */
interface DisplayLine {
  product: string;
  allowed: number;
  insurancePaid: number | null;
  deductible: number | null;
  coinsurance: number | null;
  patientOwes: number | null;
}

/**
 * Distribute deductible and coinsurance across line items proportionally
 * by their allowed amount. This is purely for display — the totals remain
 * identical to the estimator output.
 *
 * When costs can't be calculated (missing data), all cost fields are null.
 */
function distributePerLine(
  lines: OopLineItem[],
  est: OopEstimate,
): DisplayLine[] {
  const total = est.totalAllowed;

  // If we can't calculate costs, return nulls for all cost columns
  if (!est.canCalculateCosts) {
    return lines.map((l) => ({
      product: l.product,
      allowed: l.allowed,
      insurancePaid: null,
      deductible: null,
      coinsurance: null,
      patientOwes: null,
    }));
  }

  if (total === 0) {
    return lines.map((l) => ({
      product: l.product,
      allowed: l.allowed,
      insurancePaid: 0,
      deductible: 0,
      coinsurance: 0,
      patientOwes: 0,
    }));
  }

  // Medicaid: insurance pays everything
  if (est.medicaidCovers) {
    return lines.map((l) => ({
      product: l.product,
      allowed: l.allowed,
      insurancePaid: l.allowed,
      deductible: 0,
      coinsurance: 0,
      patientOwes: 0,
    }));
  }

  // Distribute deductible + coinsurance proportionally
  // If OOP max capped the total, scale coinsurance proportionally
  const oopScale = (est.patientOwesRaw ?? 0) > 0 ? (est.patientOwes ?? 0) / (est.patientOwesRaw ?? 1) : 1;

  const result: DisplayLine[] = [];
  let runningDed = 0;
  let runningCoins = 0;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const proportion = l.allowed / total;
    const isLast = i === lines.length - 1;

    // Distribute deductible
    let lineDed: number;
    if (isLast) {
      lineDed = round2((est.appliedDeductible ?? 0) - runningDed);
    } else {
      lineDed = round2((est.appliedDeductible ?? 0) * proportion);
      runningDed += lineDed;
    }

    // Distribute coinsurance
    let lineCoins: number;
    if (isLast) {
      lineCoins = round2((est.patientCoinsurance ?? 0) - runningCoins);
    } else {
      lineCoins = round2((est.patientCoinsurance ?? 0) * proportion);
      runningCoins += lineCoins;
    }

    // Apply OOP max scaling if applicable
    const linePatientOwes = round2((lineDed + lineCoins) * oopScale);
    const lineInsPaid = round2(l.allowed - linePatientOwes);

    result.push({
      product: l.product,
      allowed: l.allowed,
      insurancePaid: Math.max(0, lineInsPaid),
      deductible: lineDed,
      coinsurance: lineCoins,
      patientOwes: linePatientOwes,
    });
  }

  return result;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const DASH = "—";

/** Format a nullable number — returns dash if null */
function fmtOrDash(n: number | null): string {
  return n !== null ? fmt(n) : DASH;
}

// Per-field warning messages
const FIELD_WARNINGS: Record<string, string> = {
  deductible: "Deductible remaining is missing — cannot calculate deductible portion",
  coinsurance: "Coinsurance % is missing — cannot calculate co-ins/copay portion",
  oopMax: "OOP max remaining is missing — patient total is not capped",
};

export function OopEstimateCard({ patient, infusionSets }: Props) {
  const isCarecentrix = (patient.referralSource || "").toLowerCase().includes("carecentrix");

  const result = useMemo(() => {
    if (isCarecentrix) return null;
    const parsedSets = parseInt(patient.qtyInf1 || "0", 10) + parseInt(patient.qtyInf2 || "0", 10);
    const sets = infusionSets ?? (parsedSets > 0 ? parsedSets : 3);

    return estimateOop({
      primaryInsurance: patient.primaryInsurance,
      secondaryInsurance: patient.secondaryInsurance,
      serving: patient.serving,
      infusionSets: sets,
      deductibleRemaining: patient.deductibleRemaining,
      stediCoinsurance: patient.stediCoinsurance,
      oopMaxRemaining: patient.oopMaxRemaining,
    });
  }, [
    isCarecentrix,
    patient.primaryInsurance,
    patient.secondaryInsurance,
    patient.serving,
    patient.qtyInf1,
    patient.qtyInf2,
    patient.deductibleRemaining,
    patient.stediCoinsurance,
    patient.oopMaxRemaining,
    infusionSets,
  ]);

  // CareCentrix: replace entire OOP calculator with a note
  if (isCarecentrix) {
    return (
      <Card className="p-4">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
          OOP Estimate (Per Fill)
        </p>
        <p className="text-sm text-amber-600 font-medium">
          Carecentrix patients have to contact carecentrix directly for their OOP costs.
        </p>
      </Card>
    );
  }

  // Don't render if we can't estimate (missing insurance, no rates, no serving)
  if (!result || !result.ok) {
    if (!patient.primaryInsurance || !patient.serving) return null;
    return (
      <Card className="p-4">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">
          OOP Estimate (Per Fill)
        </p>
        <p className="text-sm text-muted-foreground italic">{result && "reason" in result ? result.reason : "Unable to estimate"}</p>
      </Card>
    );
  }

  const est = result as OopEstimate;
  const displayLines = distributePerLine(est.lines, est);
  const hasMissing = est.missingFields.length > 0 && !est.medicaidCovers;
  const costsUnknown = !est.canCalculateCosts && !est.medicaidCovers;

  // Color for patient owes — only when we have a real number
  const patientOwesColor = est.patientOwes === null
    ? "text-muted-foreground"
    : est.patientOwes === 0
      ? "text-green-600"
      : est.patientOwes > 500
        ? "text-red-600"
        : "text-blue-600";

  // When costs are unknown but OOP max warning applies, use amber for the asterisk case
  const headerOwesColor = costsUnknown ? "text-amber-600" : hasMissing ? "text-amber-600" : patientOwesColor;
  const insPaidColor = "text-green-600";

  return (
    <Card className="p-4 space-y-3">
      {/* Header: summary line */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          OOP Estimate (Per Fill)
        </p>
        <div className="text-right">
          <div className="flex items-center gap-1.5 text-sm">
            <span>Allowed <span className="font-semibold tabular-nums">{fmt(est.totalAllowed)}</span></span>
            <span className="text-muted-foreground mx-0.5">&minus;</span>
            <span>Ins. paid <span className={`font-semibold tabular-nums ${est.insurancePays !== null ? insPaidColor : "text-muted-foreground"}`}>{fmtOrDash(est.insurancePays)}</span></span>
            <span className="text-muted-foreground mx-0.5">=</span>
            <span className="text-base font-bold tabular-nums">
              Patient owes <span className={headerOwesColor}>{fmtOrDash(est.patientOwes)}{hasMissing && est.patientOwes !== null && " *"}</span>
            </span>
          </div>
          {est.canCalculateCosts && !est.medicaidCovers && (() => {
            const oopMaxHit = est.patientOwes !== null && est.patientOwesRaw !== null && est.patientOwes < est.patientOwesRaw;
            const displayCoins = oopMaxHit
              ? Math.max(0, est.patientOwes! - est.appliedDeductible!)
              : est.patientCoinsurance!;
            return (
              <p className="text-xs text-muted-foreground mt-0.5">
                Ded. {fmt(est.appliedDeductible!)} · Co-ins/Copay {fmt(displayCoins)}
                {oopMaxHit && <span className="ml-1.5 text-amber-600 font-semibold">OOP Max Hit</span>}
              </p>
            );
          })()}
          {est.medicaidCovers && (
            <p className="text-xs text-green-600 mt-0.5">{est.medicaidNote}</p>
          )}
        </div>
      </div>

      {/* Line items table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="border-b-2 border-muted">
              <th className="pb-2 pr-3 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Item</th>
              <th className="pb-2 pr-3 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold text-right">Allowed</th>
              <th className="pb-2 pr-3 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold text-right">Ins. Paid</th>
              <th className="pb-2 pr-3 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold text-right">Deductible</th>
              <th className="pb-2 pr-3 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold text-right">Co-ins / Copay</th>
              <th className="pb-2 text-[10px] uppercase tracking-wider text-muted-foreground font-semibold text-right">Patient Owes</th>
            </tr>
          </thead>
          <tbody>
            {displayLines.map((line) => (
              <tr key={line.product} className="border-b border-muted/40 last:border-0">
                <td className="py-2 pr-3 text-sm font-medium">{line.product}</td>
                <td className="py-2 pr-3 text-sm text-right tabular-nums">{fmt(line.allowed)}</td>
                {line.insurancePaid !== null ? (
                  <>
                    <td className={`py-2 pr-3 text-sm text-right tabular-nums ${insPaidColor}`}>{fmt(line.insurancePaid)}</td>
                    <td className="py-2 pr-3 text-sm text-right tabular-nums">{fmt(line.deductible!)}</td>
                    <td className="py-2 pr-3 text-sm text-right tabular-nums">{fmt(line.coinsurance!)}</td>
                    <td className={`py-2 text-sm text-right tabular-nums font-medium ${hasMissing ? "text-amber-600" : patientOwesColor}`}>{fmt(line.patientOwes!)}</td>
                  </>
                ) : (
                  <>
                    <td className="py-2 pr-3 text-sm text-right text-muted-foreground">{DASH}</td>
                    <td className="py-2 pr-3 text-sm text-right text-muted-foreground">{DASH}</td>
                    <td className="py-2 pr-3 text-sm text-right text-muted-foreground">{DASH}</td>
                    <td className="py-2 text-sm text-right text-muted-foreground">{DASH}</td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-muted">
              <td className="pt-2 pr-3 text-sm font-semibold">Total</td>
              <td className="pt-2 pr-3 text-sm text-right tabular-nums font-semibold">{fmt(est.totalAllowed)}</td>
              {est.insurancePays !== null ? (
                <>
                  <td className={`pt-2 pr-3 text-sm text-right tabular-nums font-semibold ${insPaidColor}`}>{fmt(est.insurancePays)}</td>
                  <td className="pt-2 pr-3 text-sm text-right tabular-nums font-semibold">{fmt(est.appliedDeductible!)}</td>
                  <td className="pt-2 pr-3 text-sm text-right tabular-nums font-semibold">{fmt(est.patientCoinsurance!)}</td>
                  <td className={`pt-2 text-sm text-right tabular-nums font-bold ${hasMissing ? "text-amber-600" : patientOwesColor}`}>{fmt(est.patientOwes!)}</td>
                </>
              ) : (
                <>
                  <td className="pt-2 pr-3 text-sm text-right text-muted-foreground font-semibold">{DASH}</td>
                  <td className="pt-2 pr-3 text-sm text-right text-muted-foreground font-semibold">{DASH}</td>
                  <td className="pt-2 pr-3 text-sm text-right text-muted-foreground font-semibold">{DASH}</td>
                  <td className="pt-2 text-sm text-right text-amber-600 font-bold">{DASH}</td>
                </>
              )}
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Granular missing-field warnings */}
      {hasMissing && (
        <div className="space-y-1 pt-1">
          {est.missingFields.map((field) => (
            <p key={field} className="text-xs text-amber-600 font-medium">
              ⚠ {FIELD_WARNINGS[field]}
            </p>
          ))}
          {costsUnknown && (
            <p className="text-xs text-amber-600 font-semibold">
              Run Stedi eligibility to get accurate cost estimates
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
