module Helpers
  def self.normalize_name(value)
    value.to_s.strip.gsub(/\s+/, " ")
  end

  def self.normalize_url(value)
    URI.parse(value.to_s).to_s
  end
end
