/**
 * Platform utilities shared by activation paths.
 * The MAC address is derived deterministically from the terminal identity
 * so every activation produces the same value — required by MRA.
 */

/**
 * Generates a deterministic MAC address from a store code and terminal ID.
 * MRA rejects activations with the zeroed-out default (00-00-00-00-00-00),
 * so we derive a unique but stable MAC from the terminal's identity.
 */
export function generateMac(storeCode: string, terminalId: string): string {
  let hash = 0;
  const seed = storeCode + ":" + terminalId;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  const hex = (Math.abs(hash) >>> 0).toString(16).padStart(8, "0");
  // Locally-administered, unicast address (bit 1 set, bit 0 clear)
  return (
    hex.slice(0, 2).toUpperCase() +
    "-" +
    hex.slice(2, 4).toUpperCase() +
    "-" +
    hex.slice(4, 6).toUpperCase() +
    "-" +
    hex.slice(6, 8).toUpperCase() +
    "-A1-" +
    "B2"
  );
}
