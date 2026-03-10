package com.inspiration.starter;

import org.springframework.boot.WebApplicationType;
import org.springframework.boot.builder.SpringApplicationBuilder;

public final class HelloInspiration {
  private static final StarterWorkspaceService WORKSPACE_SERVICE = new StarterWorkspaceService();

  private HelloInspiration() {
  }

  public static void main(String[] args) {
    new SpringApplicationBuilder(StarterWorkspaceApplication.class)
      .web(WebApplicationType.NONE)
      .run(args)
      .close();
    System.out.println(WORKSPACE_SERVICE.buildWelcomeMessage("Builder"));
    printSuggestedNextSteps();
  }

  private static void printSuggestedNextSteps() {
    System.out.println("Suggested next steps:");
    for (String step : WORKSPACE_SERVICE.suggestedNextSteps()) {
      System.out.println("- " + step);
    }
  }
}
