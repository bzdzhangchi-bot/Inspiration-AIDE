package com.inspiration.starter;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

class HelloInspirationTest {
  private final StarterWorkspaceService starterWorkspaceService = new StarterWorkspaceService();

  @Test
  void buildsFriendlyWelcomeMessage() {
    String message = starterWorkspaceService.buildWelcomeMessage("Starter User");
    assertTrue(message.contains("Starter User"));
    assertTrue(message.contains("Spring Boot Starter"));
  }

  @Test
  void exposesStarterNextSteps() {
    List<String> steps = starterWorkspaceService.suggestedNextSteps();
    assertFalse(steps.isEmpty());
    assertTrue(steps.contains("Read 新手引导.md"));
  }
}
