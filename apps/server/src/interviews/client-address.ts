import { isIP } from "node:net";

function normalizeAddress(value?: string) {
	const address = value?.trim().replace(/^::ffff:(?=\d+\.)/i, "");
	const family = address ? isIP(address) : 0;
	if (family === 4) return address;
	if (family === 6 && !address?.includes("%")) {
		return new URL(`http://[${address}]/`).hostname.slice(1, -1);
	}
	return undefined;
}

export function readInterviewProxyAddresses(value?: string) {
	const peers = new Set<string>();
	for (const item of (value ?? "")
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)) {
		const peer = normalizeAddress(item);
		if (!peer)
			throw new Error(
				"Interview proxy addresses must be individual IPv4 or IPv6 addresses",
			);
		peers.add(peer);
	}
	return peers;
}

export function interviewClientAddress(
	peer: string | undefined,
	reported: string | undefined,
	trustedProxies?: ReadonlySet<string>,
) {
	const direct = normalizeAddress(peer);
	if (direct && trustedProxies?.has(direct))
		return normalizeAddress(reported) ?? direct;
	return direct ?? "unknown";
}
