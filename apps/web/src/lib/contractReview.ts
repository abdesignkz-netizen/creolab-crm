export type ContractReviewState = { viewed: boolean; confirmed: boolean };

export function readContractReview(fileKey: string): ContractReviewState {
  try {
    const value = JSON.parse(sessionStorage.getItem(`basqar-contract-review:${fileKey}`) || "null");
    return { viewed: Boolean(fileKey && value?.viewed), confirmed: Boolean(fileKey && value?.confirmed) };
  } catch { return { viewed: false, confirmed: false }; }
}

export function writeContractReview(fileKey: string, state: ContractReviewState) {
  if (!fileKey) return;
  try { sessionStorage.setItem(`basqar-contract-review:${fileKey}`, JSON.stringify(state)); }
  catch { /* The current window still keeps its review state when storage is unavailable. */ }
}
