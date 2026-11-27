import { z } from "zod";
import { isWorkspaceText } from "./interview-text.ts";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const coordinate = z.number().min(-1_000_000).max(1_000_000);
const dimension = z.number().min(0).max(1_000_000);
const color = z.string().regex(/^(?:#[0-9a-fA-F]{3,8}|transparent)$/);
const point = z.tuple([coordinate, coordinate]);
const points = z.array(point).min(2).max(4_000);
const text = z
	.string()
	.max(8_000)
	.refine(
		(value) =>
			isWorkspaceText(value) &&
			(value.length <= 4_000 || Array.from(value).length <= 4_000),
	);
const arrowhead = z
	.enum([
		"arrow",
		"bar",
		"dot",
		"circle",
		"circle_outline",
		"triangle",
		"triangle_outline",
		"diamond",
		"diamond_outline",
		"crowfoot_one",
		"crowfoot_many",
		"crowfoot_one_or_many",
	])
	.nullable();
const binding = z
	.strictObject({
		elementId: id,
		focus: coordinate,
		gap: dimension,
		fixedPoint: point.nullable().optional(),
	})
	.nullable();

const base = {
	id,
	x: coordinate,
	y: coordinate,
	width: dimension,
	height: dimension,
	angle: z
		.number()
		.min(-Math.PI * 2)
		.max(Math.PI * 2),
	strokeColor: color,
	backgroundColor: color,
	strokeWidth: z.number().min(0).max(32),
	strokeStyle: z.enum(["solid", "dashed", "dotted"]),
	fillStyle: z.enum(["hachure", "cross-hatch", "solid", "zigzag"]),
	roughness: z.number().min(0).max(4),
	opacity: z.number().min(0).max(100),
	roundness: z
		.strictObject({
			type: z.union([z.literal(1), z.literal(2), z.literal(3)]),
			value: dimension.optional(),
		})
		.nullable(),
	seed: z.number().int().min(0).max(2_147_483_647),
	groupIds: z.array(id).max(16),
	boundElements: z
		.array(z.strictObject({ id, type: z.enum(["arrow", "text"]) }))
		.max(64)
		.nullable(),
	locked: z.boolean(),
};
const linear = {
	...base,
	points,
	startBinding: binding,
	endBinding: binding,
	startArrowhead: arrowhead,
	endArrowhead: arrowhead,
};
export const boardElementSchemas = {
	rectangle: z.strictObject({ ...base, type: z.literal("rectangle") }),
	ellipse: z.strictObject({ ...base, type: z.literal("ellipse") }),
	diamond: z.strictObject({ ...base, type: z.literal("diamond") }),
	line: z.strictObject({
		...linear,
		type: z.literal("line"),
		startBinding: z.null(),
		endBinding: z.null(),
	}),
	arrow: z.strictObject({
		...linear,
		type: z.literal("arrow"),
		elbowed: z.boolean(),
		fixedSegments: z
			.array(
				z.strictObject({
					start: point,
					end: point,
					index: z.number().int().min(0).max(4_000),
				}),
			)
			.max(4_000)
			.nullable()
			.optional(),
		startIsSpecial: z.boolean().nullable().optional(),
		endIsSpecial: z.boolean().nullable().optional(),
	}),
	freedraw: z.strictObject({
		...base,
		type: z.literal("freedraw"),
		points,
		pressures: z.array(z.number().min(0).max(1)).max(4_000),
		simulatePressure: z.boolean(),
	}),
	text: z.strictObject({
		...base,
		type: z.literal("text"),
		text: text.refine((value) => value.trim().length > 0),
		originalText: text,
		fontSize: z.number().min(1).max(1_000),
		fontFamily: z
			.number()
			.int()
			.min(1)
			.max(9)
			.refine((value) => value !== 4),
		textAlign: z.enum(["left", "center", "right"]),
		verticalAlign: z.enum(["top", "middle", "bottom"]),
		lineHeight: z.number().min(0.1).max(5),
		containerId: id.nullable(),
		autoResize: z.boolean(),
	}),
};
const {
	rectangle,
	ellipse,
	diamond,
	line,
	arrow,
	freedraw,
	text: textElement,
} = boardElementSchemas;
const boardElement = z.discriminatedUnion("type", [
	rectangle,
	ellipse,
	diamond,
	line,
	arrow,
	freedraw,
	textElement,
]);
export type BoardElement = z.infer<typeof boardElement>;

export const workspaceBoardSchema = z
	.strictObject({
		elements: z.array(boardElement).max(500),
	})
	.superRefine((scene, context) => {
		const byId = new Map(
			scene.elements.map((element) => [element.id, element]),
		);
		let totalPoints = 0;
		for (const [index, element] of scene.elements.entries()) {
			let invalidReference = element.boundElements?.some((ref) => {
				const target = byId.get(ref.id);
				if (ref.type === "text")
					return target?.type !== "text" || target.containerId !== element.id;
				return (
					target?.type !== "arrow" ||
					(target.startBinding?.elementId !== element.id &&
						target.endBinding?.elementId !== element.id)
				);
			});
			if ("points" in element) totalPoints += element.points.length;
			if (element.type === "arrow")
				totalPoints += (element.fixedSegments?.length ?? 0) * 2;
			if ("startBinding" in element) {
				for (const ref of [element.startBinding, element.endBinding]) {
					if (!ref) continue;
					const target = byId.get(ref.elementId);
					invalidReference ||=
						!target ||
						!["rectangle", "ellipse", "diamond", "text"].includes(
							target.type,
						) ||
						!target.boundElements?.some(
							(targetRef) =>
								targetRef.id === element.id && targetRef.type === "arrow",
						);
				}
			}
			if (element.type === "text" && element.containerId) {
				const target = byId.get(element.containerId);
				invalidReference ||=
					!target ||
					!["rectangle", "ellipse", "diamond", "arrow"].includes(target.type) ||
					!target.boundElements?.some(
						(targetRef) =>
							targetRef.id === element.id && targetRef.type === "text",
					);
			}
			if (
				element.width === 0 &&
				element.height === 0 &&
				!("points" in element)
			) {
				context.addIssue({
					code: "custom",
					path: ["elements", index, "width"],
					message: "Empty shape",
				});
			}
			if (
				element.type === "arrow" &&
				element.elbowed &&
				[element.startBinding, element.endBinding].some(
					(ref) => ref && !ref.fixedPoint,
				)
			) {
				invalidReference = true;
			}
			if (invalidReference)
				context.addIssue({
					code: "custom",
					path: ["elements", index],
					message: "Invalid scene reference",
				});
			if (
				element.type === "freedraw" &&
				(element.simulatePressure
					? element.pressures.length !== 0
					: element.pressures.length !== element.points.length)
			) {
				context.addIssue({
					code: "custom",
					path: ["elements", index, "pressures"],
					message: "Invalid stroke pressure",
				});
			}
		}
		if (
			byId.size !== scene.elements.length ||
			totalPoints > 20_000 ||
			new TextEncoder().encode(JSON.stringify(scene)).byteLength > 512 * 1024
		) {
			context.addIssue({
				code: "custom",
				path: ["elements"],
				message: "Scene exceeds its limits or contains duplicate IDs",
			});
		}
	});
