export type DocumentKind = "spec" | "guide" | "plan" | "archive" | "other" | "unknown";
export type DocumentStatus = "active" | "proposed" | "historical" | "superseded" | "unknown";
export type DocumentMetadataSource = "explicit" | "classifier" | "unknown";

export interface DocumentReference {
	path: string;
	symbol?: string;
	role: "implementation" | "test" | "mention";
}

export interface DocumentMetadata {
	kind: DocumentKind;
	status: DocumentStatus;
	kindSource: DocumentMetadataSource;
	statusSource: DocumentMetadataSource;
	references: DocumentReference[];
	warnings: string[];
}
