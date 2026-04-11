export function chunk<T>(items: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
}

export function unique<T>(items: T[]): T[] {
	return [...new Set(items)];
}

export function groupBy<T, TKey extends string | number>(items: T[], getKey: (item: T) => TKey): Record<TKey, T[]> {
	return items.reduce((groups, item) => {
		const key = getKey(item);
		groups[key] ??= [];
		groups[key].push(item);
		return groups;
	}, {} as Record<TKey, T[]>);
}

export function flatten<T>(items: T[][]): T[] {
	return items.reduce<T[]>((result, group) => result.concat(group), []);
}