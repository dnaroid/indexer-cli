export function askFailureGuide(reason: string, missingModel = false): string {
	const next = missingModel
		? "Check the model configuration with idx doctor, then retry; idx search '<query>' --mode lexical remains available."
		: "Try a narrower question or inspect the sources with idx search '<query>' --mode lexical and idx context '<question>'.";
	return `${reason}\n${next} No automatic fallback or indexing was run.`;
}
