# Adds only the focused native UI test bundle to a scratch Expo project, never the production Xcode project.
require 'xcodeproj'
project_path, scheme_name, source = ARGV
project = Xcodeproj::Project.open(project_path)
app = project.targets.find { |target| target.product_type == 'com.apple.product-type.application' }
raise 'Scratch app target missing' unless app
ui = project.new_target(:ui_test_bundle, 'PhoneComposerUITests', :ios, '16.0')
ui.add_dependency(app)
ui.source_build_phase.add_file_reference(project.main_group.new_file(source))
ui.build_configurations.each do |configuration|
  configuration.build_settings.merge!({
    'PRODUCT_NAME' => '$(TARGET_NAME)',
    'PRODUCT_BUNDLE_IDENTIFIER' => 'ai.mopilot.phone.composertests',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'SWIFT_VERSION' => '5.0',
    'TEST_TARGET_NAME' => app.name,
    'CODE_SIGNING_ALLOWED' => 'YES',
    'CODE_SIGN_IDENTITY' => '-',
    'TARGETED_DEVICE_FAMILY' => '1,2'
  })
end
project.save
scheme_path = File.join(project_path, 'xcshareddata', 'xcschemes', "#{scheme_name}.xcscheme")
scheme = Xcodeproj::XCScheme.new(scheme_path)
scheme.add_build_target(ui, false)
scheme.add_test_target(ui)
scheme.save_as(project_path, scheme_name, true)
