module StringHelper
  def self.titleize(value)
    value.to_s
      .split(/[_\s]+/)
      .reject(&:empty?)
      .map { |part| part[0].to_s.upcase + part[1..].to_s.downcase }
      .join(" ")
  end

  def self.slugify(value)
    value.to_s
      .strip
      .downcase
      .gsub(/[^a-z0-9]+/, "-")
      .gsub(/^-|-$/, "")
  end
end
