let current: { id: string; secret: string } | undefined;

function capture() {
	const match = /^\/join\/([0-9a-f-]{36})\/?$/i.exec(window.location.pathname);
	const secret = window.location.hash.slice(1);
	if (!match || !secret) return;
	current = /^[A-Za-z0-9_-]{43}$/.test(secret)
		? { id: match[1], secret }
		: undefined;
	window.history.replaceState(
		window.history.state,
		"",
		window.location.pathname + window.location.search,
	);
}

capture();
window.addEventListener("hashchange", capture);

export function invitationFragment(id: string) {
	return current?.id === id ? current.secret : undefined;
}

export function forgetInvitationFragment() {
	current = undefined;
}
