require_relative "./engine.rb"
require_relative "../game/player.rb"

module Core
  class Scheduler
    def run(job)
      {
        engine: Engine.new.boot(user_id: job[:user_id], name: job[:name]),
        player: Game::Player.new.build_profile(job[:user_id], job[:name]),
      }
    end
  end
end
