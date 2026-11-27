export async function loadWorkspaceBoard() {
	// Configure the vendor asset URL before its module registers any fonts.
	Object.assign(window, { EXCALIDRAW_ASSET_PATH: "/excalidraw-assets/" });
	const { WorkspaceBoard } = await import("./workspace-board");
	return { default: WorkspaceBoard };
}
