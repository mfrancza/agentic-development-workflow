export async function shouldResolveConflicts(
  sender: string,
  prNumber: string,
  getState: (prNumber: number) => Promise<string>,
): Promise<boolean> {
  if (sender === "") return true;

  const number = Number(prNumber);
  if (!/^[1-9][0-9]*$/.test(prNumber) || !Number.isSafeInteger(number)) {
    throw new Error("On-demand resolution requires a valid PR number.");
  }

  return (await getState(number)) === "open";
}
