module HttpConstants
  AUTHORIZATION_HEADER = "HTTP_AUTHORIZATION".freeze
  ACCESS_CONTROL_ALLOW_ORIGIN = "Access-Control-Allow-Origin".freeze
  ACCESS_CONTROL_ALLOW_HEADERS = "Access-Control-Allow-Headers".freeze
  OK = 200
  UNAUTHORIZED = 401

  def self.success?(status)
    status.to_i >= 200 && status.to_i < 300
  end

  def self.json_headers
    { "Content-Type" => "application/json" }
  end
end
