export const isWorkspaceText = (value: string) =>
	value.isWellFormed() && !value.includes("\0");
