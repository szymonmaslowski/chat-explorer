export const transferredFiles = (transfer: DataTransfer | null) => [...(transfer?.files ?? [])];
