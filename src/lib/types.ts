/**
 * Patient interface — mirrors the fields from the Welcome Call board
 * that the OOP estimator needs.
 */
export interface Patient {
  primaryInsurance: string;
  secondaryInsurance: string;
  serving: string;
  referralSource: string;
  qtyInf1: string;
  qtyInf2: string;
  deductibleRemaining: string;
  stediCoinsurance: string;
  oopMaxRemaining: string;
}
