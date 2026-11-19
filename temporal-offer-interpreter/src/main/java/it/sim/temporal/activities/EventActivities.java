package it.sim.temporal.activities;

import io.temporal.activity.ActivityInterface;
import io.temporal.activity.ActivityMethod;

/** Pubblicazione degli eventi del task "emit" (CloudEvents in JSON). In produzione: produttore Kafka. */
@ActivityInterface
public interface EventActivities {

    @ActivityMethod
    void emit(String cloudEventJson);
}
