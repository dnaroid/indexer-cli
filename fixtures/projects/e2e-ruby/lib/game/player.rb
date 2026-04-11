require_relative "../utils/helpers.rb"
require_relative "./session.rb"

module Game
  class Player
    def build_profile(id, name)
      {
        id: id,
        name: Helpers.normalize_name(name),
        state: Session.new.start_match("arena-1", [id])[:state],
      }
    end
  end
end
