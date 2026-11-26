import { DOMParser } from "@xmldom/xmldom";
import { type Entry, openPromise, type ZipFile } from "yauzl";

const contentTypes = "[Content_Types].xml";
const documentPart = "word/document.xml";
const documentRelationships = "word/_rels/document.xml.rels";
const relationshipNamespace =
	"http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const strictRelationshipNamespace =
	"http://purl.oclc.org/ooxml/officeDocument/relationships";
const maxExpanded = 50 * 1024 * 1024;
const zipOptions = {
	lazyEntries: true,
	strictFileNames: true,
	autoClose: false,
};

export class ParseLimit extends Error {}

function validateWordContentType(xml: string) {
	if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Invalid content types");
	let invalid = false;
	const document = new DOMParser({
		errorHandler: () => {
			invalid = true;
		},
	}).parseFromString(xml, "text/xml");
	const namespace =
		"http://schemas.openxmlformats.org/package/2006/content-types";
	const matches = Array.from(
		document.getElementsByTagNameNS(namespace, "Override"),
	).filter(
		(element) => element.getAttribute("PartName") === "/word/document.xml",
	);
	if (
		invalid ||
		document.documentElement?.localName !== "Types" ||
		document.documentElement.namespaceURI !== namespace ||
		matches.length !== 1 ||
		matches[0].getAttribute("ContentType") !==
			"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
	) {
		throw new Error("Invalid Word content type");
	}
}

async function validateEntries(zip: ZipFile, expanded: boolean) {
	if (zip.entryCount > 1_000) throw new ParseLimit();
	const seen = new Map<string, boolean>();
	const offsets = new Set<number>();
	let bytes = 0;
	let types = "";
	let hasTypes = false;
	let hasDocument = false;
	for await (const entry of zip.eachEntry()) {
		const filename = entry.fileName;
		const directory = filename.endsWith("/");
		const key = filename.replace(/\/$/, "").normalize("NFC").toLowerCase();
		const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
		if (
			!key ||
			/[:\p{Cc}]/u.test(filename) ||
			key
				.split("/")
				.some(
					(part) =>
						!part || part === "." || part === ".." || /[ .]$/.test(part),
				) ||
			seen.has(key) ||
			offsets.has(entry.relativeOffsetOfLocalHeader) ||
			entry.extraFields.some(({ id }) => id === 0x7075) ||
			(entry.versionMadeBy >>> 8 === 3 &&
				mode !== 0 &&
				mode !== (directory ? 0o040000 : 0o100000)) ||
			(directory && entry.uncompressedSize !== 0) ||
			!entry.canDecodeFileData() ||
			(entry.generalPurposeBitFlag & 0x2041) !== 0
		)
			throw new Error("Invalid ZIP entry");
		seen.set(key, directory);
		offsets.add(entry.relativeOffsetOfLocalHeader);
		hasTypes ||= filename === contentTypes;
		hasDocument ||= filename === documentPart;
		if (!expanded) continue;
		const header = await zip.readLocalFileHeaderPromise(entry);
		if (
			!header.fileName.equals(entry.fileNameRaw) ||
			header.compressionMethod !== entry.compressionMethod ||
			header.generalPurposeBitFlag !== entry.generalPurposeBitFlag
		) {
			throw new Error("Inconsistent ZIP entry");
		}
		if (
			bytes + entry.uncompressedSize > maxExpanded ||
			(filename === contentTypes && entry.uncompressedSize > 128 * 1024)
		)
			throw new ParseLimit();
		const stream = await zip.openReadStreamPromise(entry);
		const chunks: Buffer[] = [];
		for await (const chunk of stream) {
			bytes += chunk.length;
			if (bytes > maxExpanded) throw new ParseLimit();
			if (filename === contentTypes) chunks.push(chunk);
		}
		if (filename === contentTypes)
			types = Buffer.concat(chunks).toString("utf8");
	}
	for (const key of seen.keys()) {
		const parts = key.split("/");
		parts.pop();
		while (parts.length) {
			if (seen.get(parts.join("/")) === false)
				throw new Error("Ambiguous ZIP path");
			parts.pop();
		}
	}
	if (!hasTypes || !hasDocument) throw new Error("Missing Word document parts");
	if (expanded) validateWordContentType(types);
}

export async function inspectDocx(path: string, expanded: boolean) {
	const zip = await openPromise(path, zipOptions);
	try {
		await validateEntries(zip, expanded);
	} finally {
		zip.close();
	}
}

async function readEntry(zip: ZipFile, entry: Entry) {
	const chunks: Buffer[] = [];
	for await (const chunk of await zip.openReadStreamPromise(entry)) {
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

async function readXml(zip: ZipFile, entry: Entry, limit: number) {
	if (entry.uncompressedSize > limit) throw new ParseLimit();
	const xml = (await readEntry(zip, entry)).toString("utf8");
	if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Invalid Word XML");
	return new DOMParser({
		errorHandler: () => {
			throw new Error("Invalid Word XML");
		},
	}).parseFromString(xml, "text/xml");
}

async function bodyImages(zip: ZipFile, bodyPart: Entry, links: Entry) {
	const document = await readXml(zip, bodyPart, 4 * 1024 * 1024);
	const namespace = document.documentElement?.namespaceURI;
	const body = document.getElementsByTagNameNS(namespace ?? "", "body").item(0);
	if (!body) return [];
	const relationships = await readXml(zip, links, 128 * 1024);
	const targets = new Map<string, string>();
	for (const link of Array.from(
		relationships.getElementsByTagNameNS(
			"http://schemas.openxmlformats.org/package/2006/relationships",
			"Relationship",
		),
	)) {
		const type = link.getAttribute("Type");
		const target = link.getAttribute("Target");
		const id = link.getAttribute("Id");
		if (!id || !target || link.getAttribute("TargetMode") === "External")
			continue;
		if (
			type !== `${relationshipNamespace}/image` &&
			type !== `${strictRelationshipNamespace}/image`
		)
			continue;
		targets.set(
			id,
			target.startsWith("/") ? target.slice(1) : `word/${target}`,
		);
	}
	const images = new Set<string>();
	for (const element of Array.from(body.getElementsByTagName("*"))) {
		const attribute =
			element.localName === "blip"
				? "embed"
				: element.localName === "imagedata"
					? "id"
					: undefined;
		if (!attribute) continue;
		const id =
			element.getAttributeNS(relationshipNamespace, attribute) ||
			element.getAttributeNS(strictRelationshipNamespace, attribute);
		const target = id ? targets.get(id) : undefined;
		if (target) images.add(target);
	}
	return [...images];
}

// Only call after the Word archive has passed expanded validation.
export async function* docxScanImages(path: string, limit: number) {
	const zip = await openPromise(path, zipOptions);
	try {
		const entries = new Map<string, Entry>();
		for await (const entry of zip.eachEntry())
			entries.set(entry.fileName, entry);
		const document = entries.get(documentPart);
		const links = entries.get(documentRelationships);
		if (!document || !links) return;
		const targets = await bodyImages(zip, document, links);
		const images = targets.flatMap((target) => {
			const entry = entries.get(target);
			return entry &&
				/^word\/media\/[^/]+\.(?:jpe?g|png)$/i.test(target) &&
				entry.uncompressedSize <= 4 * 1024 * 1024
				? [entry]
				: [];
		});
		for (const entry of images.slice(0, limit)) {
			const bytes = await readEntry(zip, entry);
			if (
				bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ||
				bytes.subarray(0, 3).toString("hex") === "ffd8ff"
			) {
				yield bytes;
			}
		}
	} finally {
		zip.close();
	}
}
