module PaginationHelper
  def self.window(page:, per_page:)
    {
      page: page,
      per_page: per_page,
      start: ((page - 1) * per_page) + 1,
      finish: page * per_page,
    }
  end

  def self.offset(page:, per_page:)
    {
      limit: per_page,
      offset: (page - 1) * per_page,
    }
  end
end
