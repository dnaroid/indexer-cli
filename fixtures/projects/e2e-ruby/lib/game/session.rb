module Game
  class Session
    def initialize(players = [])
      @players = players
      @rounds = []
    end

    def start_match(room_id, players)
      @players = players
      {
        room_id: room_id,
        players: players,
        state: "active",
      }
    end

    def end_round(scoreboard)
      normalized = normalize_scores(scoreboard)
      @rounds << normalized
      {
        rounds_played: @rounds.length,
        leaderboard: normalized,
      }
    end

    private

    def normalize_scores(scoreboard)
      scoreboard.sort_by { |entry| -entry.fetch(:score, 0) }
    end
  end
end
