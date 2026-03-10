package com.inspiration.starter;

import java.time.LocalDateTime;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/starter")
public class StarterWorkspaceController {
  private final StarterWorkspaceService starterWorkspaceService;

  public StarterWorkspaceController(StarterWorkspaceService starterWorkspaceService) {
    this.starterWorkspaceService = starterWorkspaceService;
  }

  @GetMapping("/summary")
  public Map<String, Object> summary() {
    return Map.of(
      "name", "Inspiration Starter Project",
      "mode", "spring-boot-demo",
      "timestamp", LocalDateTime.now().toString(),
      "message", starterWorkspaceService.buildWelcomeMessage("Builder"),
      "nextSteps", starterWorkspaceService.suggestedNextSteps()
    );
  }
}
