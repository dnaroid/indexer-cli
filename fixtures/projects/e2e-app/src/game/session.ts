export class Session {
	private rounds: number[] = [];
	private active = false;

	constructor(public readonly matchId: string, public readonly players: string[]) {}

	start(): { matchId: string; players: number } {
		if (this.players.length < 2) {
			throw new Error("A game session needs at least two players");
		}
		this.active = true;
		this.rounds = [];
		return { matchId: this.matchId, players: this.players.length };
	}

	endRound(score: number): { round: number; total: number } {
		if (!this.active) {
			throw new Error("Cannot end a round before the match session starts");
		}
		this.rounds.push(score);
		return {
			round: this.rounds.length,
			total: this.rounds.reduce((sum, value) => sum + value, 0),
		};
	}

	finish(): { winner: string; roundsPlayed: number } {
		const bestIndex = this.rounds.length % this.players.length;
		this.active = false;
		return { winner: this.players[bestIndex] ?? this.players[0], roundsPlayed: this.rounds.length };
	}
}

export function startGame(matchId: string, players: string[]): Session {
	const session = new Session(matchId, players);
	session.start();
	return session;
}

export function endRound(session: Session, score: number): { round: number; total: number } {
	return session.endRound(score);
}