import mammoth from "mammoth";
import { inspectDocx } from "./archive.ts";

const [, , path] = process.argv;
if (!path) throw new Error("Missing input");
await inspectDocx(path, true);

let remainingImageBytes = 8 * 1024 * 1024;
const imageTypes = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
]);
const { value } = await mammoth.convertToHtml(
	{ path },
	{
		externalFileAccess: false,
		includeEmbeddedStyleMap: false,
		convertImage: mammoth.images.imgElement(async (image) => {
			if (!imageTypes.has(image.contentType) || remainingImageBytes <= 0) {
				throw new Error("Image unavailable in preview");
			}
			const bytes = await image.readAsBuffer();
			remainingImageBytes -= bytes.length;
			if (remainingImageBytes < 0) throw new Error("Image preview limit");
			return {
				src: `data:${image.contentType};base64,${bytes.toString("base64")}`,
			};
		}),
	},
);
process.stdout.write(value);
