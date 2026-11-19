package it.sim.temporal.activities;

import io.temporal.activity.ActivityInterface;
import io.temporal.activity.ActivityMethod;

/** Chiamate HTTP del task "call: http". Gli errori di rete diventano errori "communication" nel workflow. */
@ActivityInterface
public interface HttpActivities {

    /** Request: method, uri, headers, query, bodyJson. Lo status HTTP viene restituito, non trasformato in eccezione. */
    @ActivityMethod
    HttpCall.Response call(HttpCall.Request request);
}
