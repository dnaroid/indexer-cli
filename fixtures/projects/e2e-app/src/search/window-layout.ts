/**
 * Восстанавливает геометрию окна и переносит устаревшие координаты обратно
 * на подключённый монитор. Эта русская формулировка — ловушка для Unicode lexical search.
 */
export function restoreDetachedWindowBounds(
	x: number,
	y: number,
	maxX: number,
	maxY: number,
): { x: number; y: number } {
	return {
		x: Math.max(0, Math.min(x, maxX)),
		y: Math.max(0, Math.min(y, maxY)),
	};
}
