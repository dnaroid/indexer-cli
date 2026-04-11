require_relative "./notification_worker.rb"
require_relative "../helpers/string_helper.rb"

module Workers
  class EmailWorker
    def main(message)
      recipient = message.fetch(:email)
      summary = StringHelper.titleize(message[:subject] || "system update")
      NotificationWorker.new.dispatch(email: recipient, summary: summary)
    end

    def deliver(email:, body:)
      "#{email}:#{body}"
    end

    private

    def queue_name
      "email"
    end
  end
end
