require_relative "../services/auth.rb"

module Workers
  class QueueWorker
    def reserve(job)
      Services::Auth.new.authenticate(job[:user_id] || "guest")
      {
        id: job[:id] || "job-1",
        queue: queue_name,
      }
    end

    private

    def queue_name
      "default"
    end
  end
end
