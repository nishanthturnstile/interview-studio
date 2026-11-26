import { documentKindSchema, mediaTypeSchema } from "@studio/contracts";
import { extractDocument } from "./parser.ts";

const [, , path, type, kind] = process.argv;
if (!path) throw new Error("Missing input");
const result = await extractDocument(
	path,
	mediaTypeSchema.parse(type),
	documentKindSchema.parse(kind),
);
process.stdout.write(JSON.stringify(result));
