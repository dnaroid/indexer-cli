require_relative "./email_worker.rb"
require_relative "../helpers/string_helper.rb"

module Workers
  class NotificationWorker
    def dispatch(notification)
      subject = StringHelper.titleize(notification[:summary])
      EmailWorker.new.deliver(email: notification[:email], body: subject)
    end

    def main(notification)
      dispatch(notification)
    end

    private

    def channel
      "push"
    end
  end
end
