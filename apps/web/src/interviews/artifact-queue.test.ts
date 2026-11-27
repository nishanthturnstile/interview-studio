import { expect, test } from "vite-plus/test";
import { InterviewRequestError } from "./api";
import { ArtifactQueue } from "./artifact-queue";

const payload = (source: string) => ({
	language: "javascript" as const,
	source,
});
const base = { sequence: 0, revisionId: null, payload: payload("") };
const revisionTwo = { sequence: 2, revisionId: crypto.randomUUID() };
const revisionThree = {
	sequence: 3,
	revisionId: crypto.randomUUID(),
	payload: payload("peer version"),
};

test("replays an uncertain save against its original base and retains edits when the head moves", async () => {
	const attempts: unknown[] = [];
	let snapshot = base as typeof base | typeof revisionThree;
	const { promise: firstSave, reject } =
		Promise.withResolvers<typeof revisionTwo>();
	const queue = new ArtifactQueue("code", {
		read: async () => snapshot,
		save: async (input) => {
			attempts.push(input);
			return attempts.length === 1 ? firstSave : revisionTwo;
		},
		onTerminal: () => {},
	});
	try {
		await queue.start();
		queue.edit(payload("uncertain save"));
		const saving = queue.flush();
		queue.edit(payload("retained local draft"));
		reject(new TypeError("Lost response"));
		await expect(saving).rejects.toThrow("Lost response");
		snapshot = revisionThree;
		queue.observe(revisionThree);
		await expect(queue.flush()).rejects.toBeInstanceOf(InterviewRequestError);
		expect(attempts).toHaveLength(2);
		expect(attempts[1]).toEqual(attempts[0]);
		expect(queue.head.sequence).toBe(2);
		expect(queue.getSnapshot()).toMatchObject({
			conflict: true,
			dirty: true,
			draft: payload("retained local draft"),
		});
		await queue.inspect();
		expect(queue.getSnapshot().preview).toEqual(revisionThree);
		await queue.discardDraft();
		expect(queue.getSnapshot()).toMatchObject({
			conflict: false,
			dirty: false,
			draft: revisionThree.payload,
		});
		expect(queue.head.sequence).toBe(3);
	} finally {
		queue.clear();
	}
});
