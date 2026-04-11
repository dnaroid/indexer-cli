require_relative "./queue_worker.rb"
require_relative "../core/scheduler.rb"

module Workers
  class BatchProcessor
    def process(job)
      {
        queued: QueueWorker.new.reserve(job),
        scheduled: Core::Scheduler.new.run(job),
      }
    end
  end
end
