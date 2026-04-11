require "singleton"
require_relative "../constants/app_constants.rb"

module Db
  class Connection
    include Singleton

    def config
      {
        adapter: "sqlite",
        database: "tmp/#{AppConstants.service_name}.sqlite3",
      }
    end

    def execute(query)
      "executed: #{query}"
    end
  end
end
