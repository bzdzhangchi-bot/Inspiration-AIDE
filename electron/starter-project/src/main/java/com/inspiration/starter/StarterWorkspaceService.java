package com.inspiration.starter;

import java.util.List;
import org.springframework.stereotype.Service;

@Service
public class StarterWorkspaceService {
  public String buildWelcomeMessage(String userName) {
    String safeName = userName == null || userName.isBlank() ? "Friend" : userName.trim();
    return "Hello, " + safeName + ". Welcome to Inspiration Spring Boot Starter.";
  }

  public List<String> suggestedNextSteps() {
    return List.of(
      "Read 新手引导.md",
      "Inspect application.properties",
      "Open StarterWorkspaceController.java",
      "Run ./mvnw spring-boot:run",
      "Configure your provider in Settings"
    );
  }
}
