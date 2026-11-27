import { useEffect, useState, useSyncExternalStore } from "react";
import { WorkspaceClient, type WorkspaceView } from "./workspace-client";

const emptyView: WorkspaceView = { connected: false, hidden: false };
const fallbackView = () => emptyView;
const fallbackSubscribe = () => () => {};

export function useWorkspace(path: string | null) {
	const [mount, setMount] = useState<{
		path: string;
		client: WorkspaceClient;
	}>();
	const client = mount?.path === path ? mount.client : undefined;
	useEffect(() => {
		if (!path) return;
		const mounted = new WorkspaceClient(path);
		setMount({ path, client: mounted });
		mounted.start();
		return () => mounted.stop();
	}, [path]);
	const view = useSyncExternalStore(
		client?.subscribe ?? fallbackSubscribe,
		client?.getSnapshot ?? fallbackView,
	);
	return { client, view };
}
