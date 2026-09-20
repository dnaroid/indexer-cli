import { config } from "../core/config.js";
import type { MetadataStore, ProjectId, SnapshotId } from "../core/types.js";
import { computeHash } from "../utils/hash.js";

export const KNOWLEDGE_INDEX_CONFIG_ARTIFACT = "knowledge_index_config";

export function knowledgeIndexConfigFingerprint(): string {
	return computeHash(
		JSON.stringify({
			format: "knowledge-lexical-v1",
			model: config.get("knowledgeEmbeddingModel"),
				queryPrefix: config.get("knowledgeEmbeddingQueryPrefix"),
				documentPrefix: config.get("knowledgeEmbeddingDocumentPrefix"),
				vectorSize: config.get("vectorSize"),
				embeddingContextSize: config.get("embeddingContextSize"),
				ollamaNumCtx: config.get("ollamaNumCtx"),
				documentExtensions: config.get("documentExtensions"),
			documentIncludePaths: config.get("documentIncludePaths"),
			documentExcludePaths: config.get("documentExcludePaths"),
			documentMaxBytes: config.get("documentMaxBytes"),
		}),
	);
}

export async function writeKnowledgeIndexConfigArtifact(
	metadata: MetadataStore,
	projectId: ProjectId,
	snapshotId: SnapshotId,
): Promise<void> {
	await metadata.upsertArtifact(projectId, {
		projectId,
		snapshotId,
		artifactType: KNOWLEDGE_INDEX_CONFIG_ARTIFACT,
		scope: "project",
		dataJson: JSON.stringify({ fingerprint: knowledgeIndexConfigFingerprint() }),
	});
}

export async function knowledgeSnapshotNeedsRefresh(
	metadata: MetadataStore,
	projectId: ProjectId,
	snapshotId: SnapshotId,
): Promise<boolean> {
	const artifact = await metadata.getArtifact(
		projectId,
		snapshotId,
		KNOWLEDGE_INDEX_CONFIG_ARTIFACT,
		"project",
	);
	if (!artifact) return true;
	try {
		const data = JSON.parse(artifact.dataJson) as { fingerprint?: unknown };
		return data.fingerprint !== knowledgeIndexConfigFingerprint();
	} catch {
		return true;
	}
}

export function knowledgeDocumentEmbeddingText(text: string): string {
	return `${config.get("knowledgeEmbeddingDocumentPrefix")}${text}`;
}

export function knowledgeQueryEmbeddingText(text: string): string {
	return `${config.get("knowledgeEmbeddingQueryPrefix")}${text}`;
}
