pipeline {
    agent any

    environment {
        NODE_VERSION = '18'
        DOCKERHUB_CREDENTIALS = credentials('dockerhub-credentials')
        DOCKER_REGISTRY = 'docker.io/pyroborn'
        IMAGE_NAME = 'pyroborn/status-service'
        IMAGE_TAG = "${BUILD_NUMBER}"
        DOCKER_CONFIG = "${WORKSPACE}/.docker"
        GIT_REPO_URL = 'https://github.com/Pyroborn/k8s-argoCD.git'
        GIT_CREDENTIALS_ID = 'github-credentials'
    }

    stages {
        stage('Setup') {
            steps {
                // Initialize workspace
                cleanWs()
                // Source code checkout
                checkout scm
                // Install dependencies
                sh 'npm ci'
            }
        }

        stage('Test') {
            environment {
                // Test environment variables
                NODE_ENV = 'test'
                PORT = '4001'
                MONGODB_URI = 'mongodb://localhost:27017/status-service-test'
                MONGODB_DATABASE = 'status-service-test'
                JWT_SECRET = 'test-jwt-secret'
                SERVICE_API_KEY = 'test-api-key'
                RABBITMQ_URL = 'amqp://guest:guest@localhost:5672'
                LOG_LEVEL = 'error'
                JEST_JUNIT_OUTPUT_DIR = 'reports'
                JEST_JUNIT_OUTPUT_NAME = 'junit.xml'
            }
            steps {
                // Create reports directory
                sh 'mkdir -p reports'
                
                // Start MongoDB for testing (using a docker container)
                //sh '''
                //    docker run -d --name mongo-test -p 27017:27017 mongo:4.4
                //    # Wait for MongoDB to start
                //     sleep 5
                //'''
                
                // Execute tests with coverage
                sh 'npm run test:coverage -- --ci --reporters=default --reporters=jest-junit'

                // Publish test results and coverage
                junit(testResults: 'reports/junit.xml', allowEmptyResults: true)
                
                publishHTML(target: [
                    allowMissing: true,
                    alwaysLinkToLastBuild: true,
                    keepAll: true,
                    reportDir: 'coverage/lcov-report',
                    reportFiles: 'index.html',
                    reportName: 'Coverage Report'
                ])

                // Archive test artifacts
                archiveArtifacts(
                    artifacts: 'reports/**, coverage/**',
                    allowEmptyArchive: true
                )
            }
            post {
                always {
                    // Cleanup test containers
                    sh 'docker stop mongo-test || true'
                    sh 'docker rm mongo-test || true'
                }
            }
        }

        stage('Build Image') {
            steps {
                script {
                    // Build Docker image
                    sh "docker build -t ${IMAGE_NAME}:${BUILD_NUMBER} ."
                    sh "docker tag ${IMAGE_NAME}:${BUILD_NUMBER} ${IMAGE_NAME}:latest"
                }
            }
        }
        
        stage('Trivy Container Security Scan') {
            steps {
                script {
                def imageName = "${IMAGE_NAME}:${BUILD_NUMBER}"
                sh 'mkdir -p security-reports'

                // Download the official Trivy HTML template
                sh '''
                    curl -fSL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/html.tpl \
                    -o /tmp/html.tpl
                '''

                // Run Trivy scans using the downloaded html.tpl and JSON output format
                sh """
                    trivy image --no-progress --exit-code 0 --scanners vuln \
                    --format template --template "@/tmp/html.tpl" \
                    -o security-reports/trivy-report.html ${imageName}

                    trivy image --no-progress --exit-code 0 --scanners vuln \
                    --format json \
                    -o security-reports/trivy-report.json ${imageName}

                    echo "Security scan completed - results won't fail the build"
                """

                // Publish and archive reports
                publishHTML(target: [
                    allowMissing: true,
                    alwaysLinkToLastBuild: true,
                    keepAll: true,
                    reportDir: 'security-reports',
                    reportFiles: 'trivy-report.html',
                    reportName: 'Trivy Security Scan'
                ])
                archiveArtifacts artifacts: 'security-reports/**', allowEmptyArchive: true
                }
            }
        }

        stage('Push to DockerHub') {
            steps {
                script {
                    // Configure Docker credentials
                    sh '''
                        mkdir -p ${DOCKER_CONFIG}
                        echo '{"auths": {"https://index.docker.io/v1/": {}}}' > ${DOCKER_CONFIG}/config.json
                    '''
                    withCredentials([usernamePassword(credentialsId: 'dockerhub-credentials', passwordVariable: 'DOCKERHUB_PASSWORD', usernameVariable: 'DOCKERHUB_USERNAME')]) {
                        sh '''
                            echo "${DOCKERHUB_PASSWORD}" | docker login -u "${DOCKERHUB_USERNAME}" --password-stdin
                            docker push ${IMAGE_NAME}:${BUILD_NUMBER}
                            docker push ${IMAGE_NAME}:latest
                            docker logout
                        '''
                    }
                }
            }
        }

         stage('Update GitOps Repository') {
            steps {
                script {
                    // Prepare GitOps directory
                    sh 'rm -rf gitops-repo && mkdir -p gitops-repo'
                    
                    // Clone repository
                    dir('gitops-repo') {
                        // Use Git SCM for checkout
                        checkout([
                            $class: 'GitSCM',
                            branches: [[name: '*/main']],
                            extensions: [
                                [$class: 'CleanBeforeCheckout'], 
                                [$class: 'CloneOption', depth: 1, noTags: false, reference: '', shallow: true]
                            ],
                            userRemoteConfigs: [[
                                url: "${GIT_REPO_URL}",
                                credentialsId: "${GIT_CREDENTIALS_ID}"
                            ]]
                        ])
                        
                        // Configure Git credentials
                        withCredentials([usernamePassword(
                            credentialsId: "${GIT_CREDENTIALS_ID}",
                            usernameVariable: 'GIT_USERNAME',
                            passwordVariable: 'GIT_PASSWORD'
                        )]) {
                            sh """
                                # Configure Git
                                git config user.email "jenkins@example.com"
                                git config user.name "Jenkins CI"
                                
                                # Verify deployment file existence
                                ls -la deployments/ || echo "Deployments directory not found"
                                ls -la deployments/status-service/ || echo "Status service directory not found"
                                
                                if [ -f deployments/status-service/deployment.yaml ]; then
                                    echo "Found deployment file. Current content:"
                                    cat deployments/status-service/deployment.yaml
                                    
                                    # Update image tag
                                    echo "Updating image tag to ${IMAGE_NAME}:${BUILD_NUMBER}"
                                    
                                    # Locate container section
                                    if grep -A 5 "name: status-service" deployments/status-service/deployment.yaml | grep -q "image:"; then
                                        echo "Found image line near 'name: status-service', updating it..."
                                        # Update with precise indentation
                                        sed -i "s|^\\(        image: ${IMAGE_NAME}:\\).*|\\1${BUILD_NUMBER}|g" deployments/status-service/deployment.yaml
                                    else
                                        echo "WARNING: Could not find image line near 'name: status-service'. Please check the deployment file structure."
                                        # Insert image line with proper indentation
                                        sed -i "/^        - name: status-service/ a\\        image: ${IMAGE_NAME}:${BUILD_NUMBER}" deployments/status-service/deployment.yaml
                                    fi
                                    
                                    echo "Updated content:"
                                    cat deployments/status-service/deployment.yaml
                                    
                                    # Commit and push changes
                                    if git diff --quiet deployments/status-service/deployment.yaml; then
                                        echo "No changes detected in deployment file"
                                    else
                                        echo "Changes detected, committing..."
                                        git add deployments/status-service/deployment.yaml
                                        git commit -m "Update status-service image to ${BUILD_NUMBER}"
                                        
                                        # Configure remote with credentials
                                        git remote set-url origin https://${GIT_USERNAME}:${GIT_PASSWORD}@github.com/Pyroborn/k8s-argoCD.git                                        
                                        # Push changes
                                        git push origin HEAD:main
                                        echo "Successfully pushed changes to GitOps repository"
                                    fi
                                else
                                    echo "ERROR: Deployment file not found at deployments/status-service/deployment.yaml"
                                    # List YAML files for troubleshooting
                                    find . -type f -name "*.yaml" | sort
                                    exit 1
                                fi
                            """
                        }
                    }
                }
            }
    }

    stage('Checkov Infrastructure Security Scan') {
            steps {
                script {
                    // Create reports directory
                    sh 'mkdir -p security-reports'
                    
                    // Run Checkov scan on GitOps repository
                    sh '''
                        # Add pipx installation path to PATH (fix Jenkins PATH warning)
                        export PATH="$PATH:/var/lib/jenkins/.local/bin"
                        
                        echo "Starting Checkov Infrastructure Security Scan..."
                        
                        # Check if GitOps repo directory exists from previous stage
                        if [ -d "gitops-repo" ]; then
                            echo "Found GitOps repository, scanning Kubernetes manifests..."
                            
                            # Look for deployments directory structure
                            if [ -d "gitops-repo/deployments" ]; then
                                echo "Scanning deployments directory..."
                                
                                # Run Checkov scan and suppress all output
                                checkov -d gitops-repo/deployments/ \
                                    --framework kubernetes \
                                    --output json \
                                    --output-file-path security-reports/ \
                                    --soft-fail \
                                    --quiet > /dev/null 2>&1 || echo "Checkov scan completed"
                                
                            elif [ -d "gitops-repo/k8s" ]; then
                                echo "Scanning k8s directory..."
                                
                                # Run Checkov scan and suppress all output
                                checkov -d gitops-repo/k8s/ \
                                    --framework kubernetes \
                                    --output json \
                                    --output-file-path security-reports/ \
                                    --soft-fail \
                                    --quiet > /dev/null 2>&1 || echo "Checkov scan completed"
                                    
                            else
                                echo "Scanning entire GitOps repository..."
                                
                                # Run Checkov scan and suppress all output
                                checkov -d gitops-repo/ \
                                    --framework kubernetes \
                                    --output json \
                                    --output-file-path security-reports/ \
                                    --soft-fail \
                                    --quiet > /dev/null 2>&1 || echo "Checkov scan completed"
                            fi
                            
                            # Look for JSON report (Checkov might name it differently)
                            if [ -f "security-reports/results_json.json" ]; then
                                mv security-reports/results_json.json security-reports/checkov-report.json
                            fi
                            
                            # Show brief summary
                            if [ -f "security-reports/checkov-report.json" ]; then
                                echo "=== Checkov Summary ==="
                                python3 << 'EOF'
import json
try:
    with open('security-reports/checkov-report.json', 'r') as f:
        data = json.load(f)
    
    # Get summary
    summary = data.get('summary', {})
    passed = summary.get('passed', 0)
    failed = summary.get('failed', 0)
    skipped = summary.get('skipped', 0)
    
    print(f'📊 Total: {passed + failed + skipped} checks | ✅ Passed: {passed} | ❌ Failed: {failed} | ⏭️ Skipped: {skipped}')
    
    if failed > 0:
        print(f'🚨 Found {failed} security issues - generating readable report...')
        
        # Generate readable text report
        failed_checks = data.get('results', {}).get('failed_checks', [])
        
        with open('security-reports/checkov-readable-report.txt', 'w') as report:
            report.write("CHECKOV KUBERNETES SECURITY SCAN REPORT\\n")
            report.write("=" * 50 + "\\n\\n")
            report.write(f"Summary: {passed} passed, {failed} failed, {skipped} skipped\\n")
            report.write(f"Total checks: {passed + failed + skipped}\\n")
            report.write(f"Checkov version: {data.get('checkov_version', 'Unknown')}\\n\\n")
            
            report.write("FAILED SECURITY CHECKS:\\n")
            report.write("-" * 30 + "\\n\\n")
            
            for i, check in enumerate(failed_checks, 1):
                check_id = check.get('check_id', 'Unknown')
                check_name = check.get('check_name', 'Unknown Check')
                file_path = check.get('file_path', 'Unknown File')
                resource = check.get('resource', 'Unknown Resource')
                
                # Get line numbers and code context
                file_line_range = check.get('file_line_range', [])
                code_block = check.get('code_block', [])
                severity = check.get('severity', 'UNKNOWN')
                bc_check_id = check.get('bc_check_id', '')
                guideline = check.get('guideline', '')
                
                report.write(f"{i}. {check_id}: {check_name}\\n")
                report.write(f"   File: {file_path}")
                
                # Add line numbers if available
                if file_line_range and len(file_line_range) >= 2:
                    start_line = file_line_range[0]
                    end_line = file_line_range[1]
                    if start_line == end_line:
                        report.write(f" (line {start_line})")
                    else:
                        report.write(f" (lines {start_line}-{end_line})")
                report.write("\\n")
                
                report.write(f"   Resource: {resource}\\n")
                
                # Add severity if available
                if severity and severity != 'UNKNOWN':
                    report.write(f"   Severity: {severity}\\n")
                
                # Add code context if available
                if code_block and len(code_block) > 0:
                    report.write("   Code Context:\\n")
                    for line_num, line_content in code_block:
                        if isinstance(line_content, str) and line_content.strip():
                            report.write(f"     {line_num}: {line_content.rstrip()}\\n")
                
                # Add guideline/fix if available
                if guideline and guideline.strip():
                    report.write(f"   Fix: {guideline}\\n")
                elif bc_check_id:
                    report.write(f"   Check ID: {bc_check_id}\\n")
                
                report.write("\\n")
        
        print(f'📄 Readable report generated: security-reports/checkov-readable-report.txt')
        print('💡 Check archived files for complete details')
        
    else:
        print('🎉 No security issues found! All checks passed.')
        
except Exception as e:
    print(f'Could not parse summary: {e}')
    print('Check the archived JSON report for details')
EOF
                            else
                                echo "No Checkov report generated - check archived files"
                            fi
                            
                        else
                            echo "WARNING: GitOps repository not found"
                            echo '{"summary": {"failed": 0, "passed": 0, "skipped": 0}, "message": "GitOps repository not found"}' > security-reports/checkov-report.json
                        fi
                    '''
                }
            }
            post {
                always {
                    // Archive Checkov reports
                    archiveArtifacts(
                        artifacts: 'security-reports/checkov-*',
                        allowEmptyArchive: true
                    )
                }
                failure {
                    echo 'Checkov infrastructure security scan encountered issues!'
                }
                success {
                    echo 'Checkov infrastructure security scan completed successfully!'
                }
            }
        }
    }

    post {
        always {
            cleanWs()
        }
        success {
            echo 'Pipeline completed successfully!'
        }
        failure {
            echo 'Pipeline failed!'
        }
    }
}
