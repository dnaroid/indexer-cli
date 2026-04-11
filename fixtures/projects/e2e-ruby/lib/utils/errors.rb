class AppError < StandardError
  attr_reader :code

  def initialize(message = "application error", code: "app_error")
    @code = code
    super(message)
  end
end

class NotFoundError < AppError
  def initialize(message = "resource not found")
    super(message, code: "not_found")
  end
end

class ValidationError < AppError
  def initialize(message = "validation failed")
    super(message, code: "validation_error")
  end
end
