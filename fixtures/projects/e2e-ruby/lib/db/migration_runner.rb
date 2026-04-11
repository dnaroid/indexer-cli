require_relative "./connection.rb"
require_relative "../helpers/string_helper.rb"

module Db
  class MigrationRunner
    def initialize(connection = Connection.instance)
      @connection = connection
    end

    def run(name)
      migration = StringHelper.slugify(name)
      @connection.execute("apply #{migration}")
    end

    def self.bootstrap
      new.run("create_users_table")
    end
  end
end
