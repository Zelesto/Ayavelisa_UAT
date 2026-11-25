export const ACTIVE_BRANCH_STORAGE_KEY = "ayavelisa:active-branch";

export type Branch = {
  id: string;
  name: string;
  isDefault?: boolean;
};

export function attachActiveBranch(headers: Headers) {
  const branchId = window.localStorage.getItem(ACTIVE_BRANCH_STORAGE_KEY);
  if (branchId) headers.set("X-Branch-Id", branchId);
}
