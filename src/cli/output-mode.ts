export type OutputModeOptions = {
	txt?: boolean;
};

export function isJsonOutput(options?: OutputModeOptions): boolean {
	return !options?.txt;
}
