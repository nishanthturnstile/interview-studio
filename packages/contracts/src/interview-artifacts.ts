import { z } from "zod";
import { workspaceBoardSchema } from "./interview-board.ts";
import {
	codeLanguageSchema,
	codeProgramSchema,
	codeRunSummarySchema,
	codeSourceSchema,
} from "./interview-execution.ts";

export const workspaceBindingHeader = "X-Studio-Workspace";
export const workspaceBindingSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const artifactKindSchema = z.enum(["code", "board"]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

const sequence = z.number().int().min(0).max(2_147_483_647);
export const artifactHeadSchema = z.object({
	sequence,
	revisionId: z.uuid().nullable(),
});
export const workspaceHeadIdsSchema = z.strictObject({
	code: z.uuid().nullable(),
	board: z.uuid().nullable(),
});
export const workspaceDescriptorSchema = z.object({
	binding: workspaceBindingSchema,
	active: z.boolean(),
	executionEnabled: z.boolean().optional(),
	latestRun: codeRunSummarySchema.optional(),
	heads: z.object({ code: artifactHeadSchema, board: artifactHeadSchema }),
});
export const workspaceCodeSchema = codeProgramSchema
	.extend({
		drafts: z.partialRecord(codeLanguageSchema, codeSourceSchema).optional(),
	})
	.refine(({ language, drafts }) => drafts?.[language] === undefined, {
		path: ["drafts"],
	});
export const workspacePayloadSchemas = {
	code: workspaceCodeSchema,
	board: workspaceBoardSchema,
};
export type ArtifactPayload = {
	[K in ArtifactKind]: z.infer<(typeof workspacePayloadSchemas)[K]>;
};
export const emptyArtifacts: ArtifactPayload = {
	code: { language: "javascript", source: "" },
	board: { elements: [] },
};
export const emptyArtifactHead = { sequence: 0, revisionId: null };
export const artifactSchemaVersion = 1;
export const artifactRequestLimits = { code: 1280 * 1024, board: 544 * 1024 };

export const workspaceSaveSchema = z.strictObject({
	commandId: z.uuid(),
	baseSequence: sequence,
	payload: z.unknown(),
});
export function artifactSnapshotSchema<K extends ArtifactKind>(kind: K) {
	return artifactHeadSchema.extend({
		schemaVersion: z.literal(artifactSchemaVersion),
		payload: workspacePayloadSchemas[kind],
	});
}
export type WorkspaceDescriptor = z.infer<typeof workspaceDescriptorSchema>;
export type WorkspaceHeadIds = z.infer<typeof workspaceHeadIdsSchema>;
export type ArtifactHead = z.infer<typeof artifactHeadSchema>;

export const workspaceBindMessageSchema = z.strictObject({
	type: z.literal("bind"),
	binding: workspaceBindingSchema,
});

export const workspaceEventSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("ready") }),
	z.strictObject({
		type: z.literal("head-changed"),
		kind: artifactKindSchema,
		sequence,
	}),
	z.strictObject({ type: z.literal("access-ended") }),
]);
export type WorkspaceEvent = z.infer<typeof workspaceEventSchema>;

export * from "./interview-board.ts";
