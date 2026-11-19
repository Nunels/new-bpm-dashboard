package it.sim.java;

import jakarta.enterprise.context.ApplicationScoped;

import io.quarkiverse.flow.Flow;
import io.serverlessworkflow.api.types.Workflow;

/** Variante B dell'offerta mono-prodotto. */
@ApplicationScoped
public class OffSimMonoJavaFlow extends Flow {
    @Override
    public Workflow descriptor() {
        return PlanFlow.build("OFF_SIM_MONO", "offer-off-sim-mono");
    }
}
