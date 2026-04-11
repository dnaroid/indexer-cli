module AppConstants
  APP_NAME = "E2ERuby".freeze
  DEFAULT_ORIGIN = "https://example.test".freeze
  RETRY_LIMIT = 3

  def self.service_name(environment = "test")
    "#{APP_NAME.downcase}-#{environment}"
  end

  def self.default_tags
    [APP_NAME, "cli", "fixture"]
  end
end
